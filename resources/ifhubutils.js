"use strict";

      if (typeof Number.prototype.toRadians === "undefined") {
        Number.prototype.toRadians = function() {
          return this * Math.PI / 180;
        };
      }

      /** Extend Number object with method to convert radians to numeric (signed) degrees */
      if (typeof Number.prototype.toDegrees === "undefined") {
        Number.prototype.toDegrees = function() {
          return this * 180 / Math.PI;
        };
      }

      var INTERSECT_LNG = 179.999; // Lng used for intersection and wrap around on map edges

      L.Geodesic = L.Polyline.extend({
        options: {
          color: "blue",
          steps: 10,
          dash: 1,
          wrap: true
        },

        initialize: function(latlngs, options) {
          this.options = this._merge_options(this.options, options);
          this.options.dash = Math.max(1e-3, Math.min(1, parseFloat(this.options.dash) || 1));
          this.datum = {};
          this.datum.ellipsoid = {
              a: 6378137,
              b: 6356752.3142,
              f: 1 / 298.257223563
            }; // WGS-84
          this._latlngs = this._generate_Geodesic(latlngs);
          L.Polyline.prototype.initialize.call(this, this._latlngs, this.options);
        },

        setLatLngs: function(latlngs) {
          this._latlngs = this._generate_Geodesic(latlngs);
          L.Polyline.prototype.setLatLngs.call(this, this._latlngs);
        },

        /**
         * Calculates some statistic values of current geodesic multipolyline
         * @returns (Object} Object with several properties (e.g. overall distance)
         */
        getStats: function() {
          let obj = {
              distance: 0,
              points: 0,
              polygons: this._latlngs.length
            }, poly, points;

          for (poly = 0; poly < this._latlngs.length; poly++) {
            obj.points += this._latlngs[poly].length;
            for (points = 0; points < (this._latlngs[poly].length - 1); points++) {
              obj.distance += this._vincenty_inverse(this._latlngs[poly][points],
                this._latlngs[poly][points + 1]).distance;
            }
          }
          return obj;
        },


        /**
         * Creates geodesic lines from geoJson. Replaces all current features of this instance.
         * Supports LineString, MultiLineString and Polygon
         * @param {Object} geojson - geosjon as object.
         */
        geoJson: function(geojson) {

          let normalized = L.GeoJSON.asFeature(geojson);
          let features = normalized.type === "FeatureCollection" ? normalized.features : [
            normalized
          ];
          this._latlngs = [];
          for (let feature of features) {
            let geometry = feature.type === "Feature" ? feature.geometry :
              feature,
              coords = geometry.coordinates;

            switch (geometry.type) {
              case "LineString":
                this._latlngs.push(this._generate_Geodesic([L.GeoJSON.coordsToLatLngs(
                  coords, 0)]));
                break;
              case "MultiLineString":
              case "Polygon":
                this._latlngs.push(this._generate_Geodesic(L.GeoJSON.coordsToLatLngs(
                  coords, 1)));
                break;
              case "Point":
              case "MultiPoint":
                console.log("Dude, points can't be drawn as geodesic lines...");
                break;
              default:
                console.log("Drawing " + geometry.type +
                  " as a geodesic is not supported. Skipping...");
            }
          }
          L.Polyline.prototype.setLatLngs.call(this, this._latlngs);
        },

        /**
         * Creates a great circle. Replaces all current lines.
         * @param {Object} center - geographic position
         * @param {number} radius - radius of the circle in metres
         */
        createCircle: function(center, radius) {
          let polylineIndex = 0;
          let prev = {
            lat: 0,
            lng: 0,
            brg: 0
          };
          let step;

          this._latlngs = [];
          this._latlngs[polylineIndex] = [];

          let direct = this._vincenty_direct(L.latLng(center), 0, radius, this.options
            .wrap);
          prev = L.latLng(direct.lat, direct.lng);
          this._latlngs[polylineIndex].push(prev);
          for (step = 1; step <= this.options.steps;) {
            direct = this._vincenty_direct(L.latLng(center), 360 / this.options
              .steps * step, radius, this.options.wrap);
            let gp = L.latLng(direct.lat, direct.lng);
            if (Math.abs(gp.lng - prev.lng) > 180) {
              let inverse = this._vincenty_inverse(prev, gp);
              let sec = this._intersection(prev, inverse.initialBearing, {
                lat: -89,
                lng: ((gp.lng - prev.lng) > 0) ? -INTERSECT_LNG : INTERSECT_LNG
              }, 0);
              if (sec) {
                this._latlngs[polylineIndex].push(L.latLng(sec.lat, sec.lng));
                polylineIndex++;
                this._latlngs[polylineIndex] = [];
                prev = L.latLng(sec.lat, -sec.lng);
                this._latlngs[polylineIndex].push(prev);
              } else {
                polylineIndex++;
                this._latlngs[polylineIndex] = [];
                this._latlngs[polylineIndex].push(gp);
                prev = gp;
                step++;
              }
            } else {
              this._latlngs[polylineIndex].push(gp);
              prev = gp;
              step++;
            }
          }

          L.Polyline.prototype.setLatLngs.call(this, this._latlngs);
        },

        /**
         * Creates a geodesic Polyline from given coordinates
         * Note: dashed lines are under work
         * @param {Object} latlngs - One or more polylines as an array. See Leaflet doc about Polyline
         * @returns (Object} An array of arrays of geographical points.
         */
        _generate_Geodesic: function(latlngs) {
          let _geo = [], _geocnt = 0;

          for (let poly = 0; poly < latlngs.length; poly++) {
            _geo[_geocnt] = [];
            let prev = L.latLng(latlngs[poly][0]);
            for (let points = 0; points < (latlngs[poly].length - 1); points++) {
              // use prev, so that wrapping behaves correctly
              let pointA = prev;
              let pointB = L.latLng(latlngs[poly][points + 1]);
              if (pointA.equals(pointB)) {
                continue;
              }
              let inverse = this._vincenty_inverse(pointA, pointB);
              _geo[_geocnt].push(prev);
              for (let s = 1; s <= this.options.steps;) {
                let distance = inverse.distance / this.options.steps;
                // dashed lines don't go the full distance between the points
                let dist_mult = s - 1 + this.options.dash;
                let direct = this._vincenty_direct(pointA, inverse.initialBearing, distance*dist_mult, this.options.wrap);
                let gp = L.latLng(direct.lat, direct.lng);
                if (Math.abs(gp.lng - prev.lng) > 180) {
                  let sec = this._intersection(pointA, inverse.initialBearing, {
                    lat: -89,
                    lng: ((gp.lng - prev.lng) > 0) ? -INTERSECT_LNG : INTERSECT_LNG
                  }, 0);
                  if (sec) {
                    _geo[_geocnt].push(L.latLng(sec.lat, sec.lng));
                    _geocnt++;
                    _geo[_geocnt] = [];
                    prev = L.latLng(sec.lat, -sec.lng);
                    _geo[_geocnt].push(prev);
                  } else {
                    _geocnt++;
                    _geo[_geocnt] = [];
                    _geo[_geocnt].push(gp);
                    prev = gp;
                    s++;
                  }
                } else {
                  _geo[_geocnt].push(gp);
                  // Dashed lines start a new line
                  if (this.options.dash < 1){
                      _geocnt++;
                      // go full distance this time, to get starting point for next line
                      let direct_full = this._vincenty_direct(pointA, inverse.initialBearing, distance*s, this.options.wrap);
                      _geo[_geocnt] = [];
                      prev = L.latLng(direct_full.lat, direct_full.lng);
                      _geo[_geocnt].push(prev);
                  }
                  else prev = gp;
                  s++;
                }
              }
            }
            _geocnt++;
          }
          return _geo;
        },

        /**
         * Vincenty direct calculation.
         * based on the work of Chris Veness (https://github.com/chrisveness/geodesy)
         *
         * @private
         * @param {number} initialBearing - Initial bearing in degrees from north.
         * @param {number} distance - Distance along bearing in metres.
         * @returns (Object} Object including point (destination point), finalBearing.
         */

        _vincenty_direct: function(p1, initialBearing, distance, wrap) {
          var phi1 = p1.lat.toRadians(),
            lambda1 = p1.lng.toRadians();
          var alpha1 = initialBearing.toRadians();
          var s = distance;

          var a = this.datum.ellipsoid.a,
            b = this.datum.ellipsoid.b,
            f = this.datum.ellipsoid.f;

          var sinalpha1 = Math.sin(alpha1);
          var cosalpha1 = Math.cos(alpha1);

          var tanU1 = (1 - f) * Math.tan(phi1),
            cosU1 = 1 / Math.sqrt((1 + tanU1 * tanU1)),
            sinU1 = tanU1 * cosU1;
          var sigma1 = Math.atan2(tanU1, cosalpha1);
          var sinalpha = cosU1 * sinalpha1;
          var cosSqalpha = 1 - sinalpha * sinalpha;
          var uSq = cosSqalpha * (a * a - b * b) / (b * b);
          var A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 *
            uSq)));
          var B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

          var sigma = s / (b * A),
            sigmaprime, iterations = 0;
          var sinsigma, cossigma;
          var cos2sigmaM;
          do {
            cos2sigmaM = Math.cos(2 * sigma1 + sigma);
            sinsigma = Math.sin(sigma);
            cossigma = Math.cos(sigma);
            var Deltasigma = B * sinsigma * (cos2sigmaM + B / 4 * (cossigma * (-1 + 2 * cos2sigmaM *
                cos2sigmaM) -
              B / 6 * cos2sigmaM * (-3 + 4 * sinsigma * sinsigma) * (-3 + 4 * cos2sigmaM *
                cos2sigmaM)));
            sigmaprime = sigma;
            sigma = s / (b * A) + Deltasigma;
          } while (Math.abs(sigma - sigmaprime) > 1e-12 && ++iterations);

          var x = sinU1 * sinsigma - cosU1 * cossigma * cosalpha1;
          var phi2 = Math.atan2(sinU1 * cossigma + cosU1 * sinsigma * cosalpha1, (1 - f) *
            Math.sqrt(sinalpha * sinalpha + x * x));
          var lambda = Math.atan2(sinsigma * sinalpha1, cosU1 * cossigma - sinU1 * sinsigma * cosalpha1);
          var C = f / 16 * cosSqalpha * (4 + f * (4 - 3 * cosSqalpha));
          var L = lambda - (1 - C) * f * sinalpha *
            (sigma + C * sinsigma * (cos2sigmaM + C * cossigma * (-1 + 2 * cos2sigmaM * cos2sigmaM)));

          var lambda2;
          if (wrap) {
            lambda2 = (lambda1 + L + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // normalise to -180...+180
          } else {
            lambda2 = (lambda1 + L); // do not normalize
          }

          var revAz = Math.atan2(sinalpha, -x);

          return {
            lat: phi2.toDegrees(),
            lng: lambda2.toDegrees(),
            finalBearing: revAz.toDegrees()
          };
        },

        /**
         * Vincenty inverse calculation.
         * based on the work of Chris Veness (https://github.com/chrisveness/geodesy)
         *
         * @private
         * @param {LatLng} p1 - Latitude/longitude of start point.
         * @param {LatLng} p2 - Latitude/longitude of destination point.
         * @returns {Object} Object including distance, initialBearing, finalBearing.
         * @throws {Error} If formula failed to converge.
         */
        _vincenty_inverse: function(p1, p2) {
          var phi1 = p1.lat.toRadians(),
            lambda1 = p1.lng.toRadians();
          var phi2 = p2.lat.toRadians(),
            lambda2 = p2.lng.toRadians();

          var a = this.datum.ellipsoid.a,
            b = this.datum.ellipsoid.b,
            f = this.datum.ellipsoid.f;

          var L = lambda2 - lambda1;
          var tanU1 = (1 - f) * Math.tan(phi1),
            cosU1 = 1 / Math.sqrt((1 + tanU1 * tanU1)),
            sinU1 = tanU1 * cosU1;
          var tanU2 = (1 - f) * Math.tan(phi2),
            cosU2 = 1 / Math.sqrt((1 + tanU2 * tanU2)),
            sinU2 = tanU2 * cosU2;

          var lambda = L,
            lambdaprime, iterations = 0;
          var cosSqalpha, sinsigma, cos2sigmaM, cossigma, sigma, sinlambda, coslambda;
          do {
            sinlambda = Math.sin(lambda);
            coslambda = Math.cos(lambda);
            var sinSqsigma = (cosU2 * sinlambda) * (cosU2 * sinlambda) + (cosU1 * sinU2 -
              sinU1 * cosU2 * coslambda) * (cosU1 * sinU2 - sinU1 * cosU2 * coslambda);
            sinsigma = Math.sqrt(sinSqsigma);
            if (sinsigma == 0) return 0; // co-incident points
            cossigma = sinU1 * sinU2 + cosU1 * cosU2 * coslambda;
            sigma = Math.atan2(sinsigma, cossigma);
            var sinalpha = cosU1 * cosU2 * sinlambda / sinsigma;
            cosSqalpha = 1 - sinalpha * sinalpha;
            cos2sigmaM = cossigma - 2 * sinU1 * sinU2 / cosSqalpha;
            if (isNaN(cos2sigmaM)) cos2sigmaM = 0; // equatorial line: cosSqalpha=0 (§6)
            var C = f / 16 * cosSqalpha * (4 + f * (4 - 3 * cosSqalpha));
            lambdaprime = lambda;
            lambda = L + (1 - C) * f * sinalpha * (sigma + C * sinsigma * (cos2sigmaM + C * cossigma * (-
              1 + 2 * cos2sigmaM * cos2sigmaM)));
          } while (Math.abs(lambda - lambdaprime) > 1e-12 && ++iterations < 100);
          if (iterations >= 100) {
            console.log("Formula failed to converge. Altering target position.");
            return this._vincenty_inverse(p1, {
                lat: p2.lat,
                lng: p2.lng - 0.01
              });
              //  throw new Error('Formula failed to converge');
          }

          var s = b * A * (sigma - Deltasigma);

          var fwdAz = Math.atan2(cosU2 * sinlambda, cosU1 * sinU2 - sinU1 * cosU2 *
            coslambda);
          var revAz = Math.atan2(cosU1 * sinlambda, -sinU1 * cosU2 + cosU1 * sinU2 *
            coslambda);

          s = Number(s.toFixed(3)); // round to 1mm precision
          return {
            distance: s,
            initialBearing: fwdAz.toDegrees(),
            finalBearing: revAz.toDegrees()
          };
        },


        /**
         * Returns the point of intersection of two paths defined by point and bearing.
         * based on the work of Chris Veness (https://github.com/chrisveness/geodesy)
         *
         * @param {LatLon} p1 - First point.
         * @param {number} brng1 - Initial bearing from first point.
         * @param {LatLon} p2 - Second point.
         * @param {number} brng2 - Initial bearing from second point.
         * @returns {Object} containing lat/lng information of intersection.
         *
         * @example
         * var p1 = LatLon(51.8853, 0.2545), brng1 = 108.55;
         * var p2 = LatLon(49.0034, 2.5735), brng2 = 32.44;
         * var pInt = LatLon.intersection(p1, brng1, p2, brng2); // pInt.toString(): 50.9078°N, 4.5084°E
         */
        _intersection: function(p1, brng1, p2, brng2) {
          // see http://williams.best.vwh.net/avform.htm#Intersection

          var phi1 = p1.lat.toRadians(),
            lambda1 = p1.lng.toRadians();
          var phi2 = p2.lat.toRadians(),
            lambda2 = p2.lng.toRadians();
          var theta13 = Number(brng1).toRadians(),
            theta23 = Number(brng2).toRadians();
          var Deltaphi = phi2 - phi1,
            Deltalambda = lambda2 - lambda1;

          var Delta12 = 2 * Math.asin(Math.sqrt(Math.sin(Deltaphi / 2) * Math.sin(Deltaphi / 2) +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(Deltalambda / 2) * Math.sin(Deltalambda /
              2)));
          if (Delta12 == 0) return null;

          // initial/final bearings between points
          var theta1 = Math.acos((Math.sin(phi2) - Math.sin(phi1) * Math.cos(Delta12)) /
            (Math.sin(Delta12) * Math.cos(phi1)));
          if (isNaN(theta1)) theta1 = 0; // protect against rounding
          var theta2 = Math.acos((Math.sin(phi1) - Math.sin(phi2) * Math.cos(Delta12)) /
            (Math.sin(Delta12) * Math.cos(phi2)));
          var theta12, theta21;
          if (Math.sin(lambda2 - lambda1) > 0) {
            theta12 = theta1;
            theta21 = 2 * Math.PI - theta2;
          } else {
            theta12 = 2 * Math.PI - theta1;
            theta21 = theta2;
          }

          var alpha1 = (theta13 - theta12 + Math.PI) % (2 * Math.PI) - Math.PI; // angle 2-1-3
          var alpha2 = (theta21 - theta23 + Math.PI) % (2 * Math.PI) - Math.PI; // angle 1-2-3

          if (Math.sin(alpha1) == 0 && Math.sin(alpha2) == 0) return null; // infinite intersections
          if (Math.sin(alpha1) * Math.sin(alpha2) < 0) return null; // ambiguous intersection

          //alpha1 = Math.abs(alpha1);
          //alpha2 = Math.abs(alpha2);
          // ... Ed Williams takes abs of alpha1/alpha2, but seems to break calculation?

          var alpha3 = Math.acos(-Math.cos(alpha1) * Math.cos(alpha2) +
            Math.sin(alpha1) * Math.sin(alpha2) * Math.cos(Delta12));
          var Delta13 = Math.atan2(Math.sin(Delta12) * Math.sin(alpha1) * Math.sin(alpha2),
            Math.cos(alpha2) + Math.cos(alpha1) * Math.cos(alpha3));
          var phi3 = Math.asin(Math.sin(phi1) * Math.cos(Delta13) +
            Math.cos(phi1) * Math.sin(Delta13) * Math.cos(theta13));
          var Deltalambda13 = Math.atan2(Math.sin(theta13) * Math.sin(Delta13) * Math.cos(phi1),
            Math.cos(Delta13) - Math.sin(phi1) * Math.sin(phi3));
          var lambda3 = lambda1 + Deltalambda13;
          lambda3 = (lambda3 + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // normalise to -180..+180º

          return {
            lat: phi3.toDegrees(),
            lng: lambda3.toDegrees()
          };
        },

        /**
         * Overwrites obj1's values with obj2's and adds obj2's if non existent in obj1
         * @param obj1
         * @param obj2
         * @returns obj3 a new object based on obj1 and obj2
         */
        _merge_options: function(obj1, obj2) {
          let obj3 = {};
          for (let attrname in obj1) {
            obj3[attrname] = obj1[attrname];
          }
          for (let attrname in obj2) {
            obj3[attrname] = obj2[attrname];
          }
          return obj3;
        }
      });

      L.geodesic = function(latlngs, options) {
        return new L.Geodesic(latlngs, options);
        };

        L.interpolatePosition = function(p1, p2, duration, t) {
    var k = t/duration;
    k = (k > 0) ? k : 0;
    k = (k > 1) ? 1 : k;
    return L.latLng(p1.lat + k * (p2.lat - p1.lat),
        p1.lng + k * (p2.lng - p1.lng));
};

L.Marker.MovingMarker = L.Marker.extend({

    //state constants
    statics: {
        notStartedState: 0,
        endedState: 1,
        pausedState: 2,
        runState: 3
    },

    options: {
        autostart: false,
        loop: false,
    },

    initialize: function (latlngs, durations, options) {
        L.Marker.prototype.initialize.call(this, latlngs[0], options);

        this._latlngs = latlngs.map(function(e, index) {
            return L.latLng(e);
        });

        if (durations instanceof Array) {
            this._durations = durations;
        } else {
            this._durations = this._createDurations(this._latlngs, durations);
        }

        this._currentDuration = 0;
        this._currentIndex = 0;

        this._state = L.Marker.MovingMarker.notStartedState;
        this._startTime = 0;
        this._startTimeStamp = 0;  // timestamp given by requestAnimFrame
        this._pauseStartTime = 0;
        this._animId = 0;
        this._animRequested = false;
        this._currentLine = [];
        this._stations = {};
    },

    isRunning: function() {
        return this._state === L.Marker.MovingMarker.runState;
    },

    isEnded: function() {
        return this._state === L.Marker.MovingMarker.endedState;
    },

    isStarted: function() {
        return this._state !== L.Marker.MovingMarker.notStartedState;
    },

    isPaused: function() {
        return this._state === L.Marker.MovingMarker.pausedState;
    },

    start: function() {
        if (this.isRunning()) {
            return;
        }

        if (this.isPaused()) {
            this.resume();
        } else {
            this._loadLine(0);
            this._startAnimation();
            this.fire('start');
        }
    },

    resume: function() {
        if (! this.isPaused()) {
            return;
        }
        // update the current line
        this._currentLine[0] = this.getLatLng();
        this._currentDuration -= (this._pauseStartTime - this._startTime);
        this._startAnimation();
    },

    pause: function() {
        if (! this.isRunning()) {
            return;
        }

        this._pauseStartTime = Date.now();
        this._state = L.Marker.MovingMarker.pausedState;
        this._stopAnimation();
        this._updatePosition();
    },

    stop: function(elapsedTime) {
        if (this.isEnded()) {
            return;
        }

        this._stopAnimation();

        if (typeof(elapsedTime) === 'undefined') {
            // user call
            elapsedTime = 0;
            this._updatePosition();
        }

        this._state = L.Marker.MovingMarker.endedState;
        this.fire('end', {elapsedTime: elapsedTime});
    },

    addLatLng: function(latlng, duration) {
        this._latlngs.push(L.latLng(latlng));
        this._durations.push(duration);
    },

    moveTo: function(latlng, duration) {
        this._stopAnimation();
        this._latlngs = [this.getLatLng(), L.latLng(latlng)];
        this._durations = [duration];
        this._state = L.Marker.MovingMarker.notStartedState;
        this.start();
        this.options.loop = false;
    },

    addStation: function(pointIndex, duration) {
        if (pointIndex > this._latlngs.length - 2 || pointIndex < 1) {
            return;
        }
        this._stations[pointIndex] = duration;
    },

    onAdd: function (map) {
        L.Marker.prototype.onAdd.call(this, map);

        if (this.options.autostart && (! this.isStarted())) {
            this.start();
            return;
        }

        if (this.isRunning()) {
            this._resumeAnimation();
        }
    },

    onRemove: function(map) {
        L.Marker.prototype.onRemove.call(this, map);
        this._stopAnimation();
    },

    _createDurations: function (latlngs, duration) {
        var lastIndex = latlngs.length - 1;
        var distances = [];
        var totalDistance = 0;
        var distance = 0;

        // compute array of distances between points
        for (var i = 0; i < lastIndex; i++) {
            distance = latlngs[i + 1].distanceTo(latlngs[i]);
            distances.push(distance);
            totalDistance += distance;
        }

        var ratioDuration = duration / totalDistance;

        var durations = [];
        for (i = 0; i < distances.length; i++) {
            durations.push(distances[i] * ratioDuration);
        }

        return durations;
    },

    _startAnimation: function() {
        this._state = L.Marker.MovingMarker.runState;
        this._animId = L.Util.requestAnimFrame(function(timestamp) {
            this._startTime = Date.now();
            this._startTimeStamp = timestamp;
            this._animate(timestamp);
        }, this, true);
        this._animRequested = true;
    },

    _resumeAnimation: function() {
        if (! this._animRequested) {
            this._animRequested = true;
            this._animId = L.Util.requestAnimFrame(function(timestamp) {
                this._animate(timestamp);
            }, this, true);
        }
    },

    _stopAnimation: function() {
        if (this._animRequested) {
            L.Util.cancelAnimFrame(this._animId);
            this._animRequested = false;
        }
    },

    _updatePosition: function() {
        var elapsedTime = Date.now() - this._startTime;
        this._animate(this._startTimeStamp + elapsedTime, true);
    },

    _loadLine: function(index) {
        this._currentIndex = index;
        this._currentDuration = this._durations[index];
        this._currentLine = this._latlngs.slice(index, index + 2);
    },

    /**
     * Load the line where the marker is
     * @param  {Number} timestamp
     * @return {Number} elapsed time on the current line or null if
     * we reached the end or marker is at a station
     */
    _updateLine: function(timestamp) {
        // time elapsed since the last latlng
        var elapsedTime = timestamp - this._startTimeStamp;

        // not enough time to update the line
        if (elapsedTime <= this._currentDuration) {
            return elapsedTime;
        }

        var lineIndex = this._currentIndex;
        var lineDuration = this._currentDuration;
        var stationDuration;

        while (elapsedTime > lineDuration) {
            // substract time of the current line
            elapsedTime -= lineDuration;
            stationDuration = this._stations[lineIndex + 1];

            // test if there is a station at the end of the line
            if (stationDuration !== undefined) {
                if (elapsedTime < stationDuration) {
                    this.setLatLng(this._latlngs[lineIndex + 1]);
                    return null;
                }
                elapsedTime -= stationDuration;
            }

            lineIndex++;

            // test if we have reached the end of the polyline
            if (lineIndex >= this._latlngs.length - 1) {

                if (this.options.loop) {
                    lineIndex = 0;
                    this.fire('loop', {elapsedTime: elapsedTime});
                } else {
                    // place the marker at the end, else it would be at
                    // the last position
                    this.setLatLng(this._latlngs[this._latlngs.length - 1]);
                    this.stop(elapsedTime);
                    return null;
                }
            }
            lineDuration = this._durations[lineIndex];
        }

        this._loadLine(lineIndex);
        this._startTimeStamp = timestamp - elapsedTime;
        this._startTime = Date.now() - elapsedTime;
        return elapsedTime;
    },

    _animate: function(timestamp, noRequestAnim) {
        this._animRequested = false;

        // find the next line and compute the new elapsedTime
        var elapsedTime = this._updateLine(timestamp);

        if (this.isEnded()) {
            // no need to animate
            return;
        }

        if (elapsedTime != null) {
              // compute the position
            var p = L.interpolatePosition(this._currentLine[0],
                this._currentLine[1],
                this._currentDuration,
                elapsedTime);
            this.setLatLng(p);
        }

        if (! noRequestAnim) {
            this._animId = L.Util.requestAnimFrame(this._animate, this, false);
            this._animRequested = true;
        }
    }
});

L.Marker.movingMarker = function (latlngs, duration, options) {
    return new L.Marker.MovingMarker(latlngs, duration, options);
};

function destinationPoint(lat, lon, distance, bearing) {
    var radius = 6371e3; // (Mean) radius of earth

    var toRadians = function(v) { return v * Math.PI / 180; };
    var toDegrees = function(v) { return v * 180 / Math.PI; };

    // sinphi2 = sinphi1·cosDelta + cosphi1·sinDelta·costheta
    // tanDeltalambda = sintheta·sinDelta·cosphi1 / cosDelta−sinphi1·sinphi2
    // see mathforum.org/library/drmath/view/52049.html for derivation

    var Delta = Number(distance) / radius; // angular distance in radians
    var theta = toRadians(Number(bearing));

    var phi1 = toRadians(Number(lat));
    var lambda1 = toRadians(Number(lon));

    var sinphi1 = Math.sin(phi1), cosphi1 = Math.cos(phi1);
    var sinDelta = Math.sin(Delta), cosDelta = Math.cos(Delta);
    var sintheta = Math.sin(theta), costheta = Math.cos(theta);

    var sinphi2 = sinphi1*cosDelta + cosphi1*sinDelta*costheta;
    var phi2 = Math.asin(sinphi2);
    var y = sintheta * sinDelta * cosphi1;
    var x = cosDelta - sinphi1 * sinphi2;
    var lambda2 = lambda1 + Math.atan2(y, x);

    return [toDegrees(phi2), (toDegrees(lambda2)+540)%360-180]; // normalise to −180..+180°
}
