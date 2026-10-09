"use strict";
var AutoCopperPolygonClipping = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/clipper-lib/clipper.js
  var require_clipper = __commonJS({
    "node_modules/clipper-lib/clipper.js"(exports, module) {
      (function() {
        "use strict";
        var ClipperLib2 = {};
        ClipperLib2.version = "6.4.2.2";
        ClipperLib2.use_lines = true;
        ClipperLib2.use_xyz = false;
        var isNode = false;
        if (typeof module !== "undefined" && module.exports) {
          module.exports = ClipperLib2;
          isNode = true;
        } else {
          if (typeof define === "function" && define.amd) {
            define(ClipperLib2);
          }
          if (typeof document !== "undefined") window.ClipperLib = ClipperLib2;
          else self["ClipperLib"] = ClipperLib2;
        }
        var navigator_appName;
        if (!isNode) {
          var nav = navigator.userAgent.toString().toLowerCase();
          navigator_appName = navigator.appName;
        } else {
          var nav = "chrome";
          navigator_appName = "Netscape";
        }
        var browser = {};
        if (nav.indexOf("chrome") != -1 && nav.indexOf("chromium") == -1) browser.chrome = 1;
        else browser.chrome = 0;
        if (nav.indexOf("chromium") != -1) browser.chromium = 1;
        else browser.chromium = 0;
        if (nav.indexOf("safari") != -1 && nav.indexOf("chrome") == -1 && nav.indexOf("chromium") == -1) browser.safari = 1;
        else browser.safari = 0;
        if (nav.indexOf("firefox") != -1) browser.firefox = 1;
        else browser.firefox = 0;
        if (nav.indexOf("firefox/17") != -1) browser.firefox17 = 1;
        else browser.firefox17 = 0;
        if (nav.indexOf("firefox/15") != -1) browser.firefox15 = 1;
        else browser.firefox15 = 0;
        if (nav.indexOf("firefox/3") != -1) browser.firefox3 = 1;
        else browser.firefox3 = 0;
        if (nav.indexOf("opera") != -1) browser.opera = 1;
        else browser.opera = 0;
        if (nav.indexOf("msie 10") != -1) browser.msie10 = 1;
        else browser.msie10 = 0;
        if (nav.indexOf("msie 9") != -1) browser.msie9 = 1;
        else browser.msie9 = 0;
        if (nav.indexOf("msie 8") != -1) browser.msie8 = 1;
        else browser.msie8 = 0;
        if (nav.indexOf("msie 7") != -1) browser.msie7 = 1;
        else browser.msie7 = 0;
        if (nav.indexOf("msie ") != -1) browser.msie = 1;
        else browser.msie = 0;
        ClipperLib2.biginteger_used = null;
        var dbits;
        var canary = 244837814094590;
        var j_lm = (canary & 16777215) == 15715070;
        function BigInteger(a, b, c) {
          ClipperLib2.biginteger_used = 1;
          if (a != null)
            if ("number" == typeof a && "undefined" == typeof b) this.fromInt(a);
            else if ("number" == typeof a) this.fromNumber(a, b, c);
            else if (b == null && "string" != typeof a) this.fromString(a, 256);
            else this.fromString(a, b);
        }
        function nbi() {
          return new BigInteger(null, void 0, void 0);
        }
        function am1(i, x, w, j, c, n) {
          while (--n >= 0) {
            var v = x * this[i++] + w[j] + c;
            c = Math.floor(v / 67108864);
            w[j++] = v & 67108863;
          }
          return c;
        }
        function am2(i, x, w, j, c, n) {
          var xl = x & 32767, xh = x >> 15;
          while (--n >= 0) {
            var l = this[i] & 32767;
            var h = this[i++] >> 15;
            var m = xh * l + h * xl;
            l = xl * l + ((m & 32767) << 15) + w[j] + (c & 1073741823);
            c = (l >>> 30) + (m >>> 15) + xh * h + (c >>> 30);
            w[j++] = l & 1073741823;
          }
          return c;
        }
        function am3(i, x, w, j, c, n) {
          var xl = x & 16383, xh = x >> 14;
          while (--n >= 0) {
            var l = this[i] & 16383;
            var h = this[i++] >> 14;
            var m = xh * l + h * xl;
            l = xl * l + ((m & 16383) << 14) + w[j] + c;
            c = (l >> 28) + (m >> 14) + xh * h;
            w[j++] = l & 268435455;
          }
          return c;
        }
        if (j_lm && navigator_appName == "Microsoft Internet Explorer") {
          BigInteger.prototype.am = am2;
          dbits = 30;
        } else if (j_lm && navigator_appName != "Netscape") {
          BigInteger.prototype.am = am1;
          dbits = 26;
        } else {
          BigInteger.prototype.am = am3;
          dbits = 28;
        }
        BigInteger.prototype.DB = dbits;
        BigInteger.prototype.DM = (1 << dbits) - 1;
        BigInteger.prototype.DV = 1 << dbits;
        var BI_FP = 52;
        BigInteger.prototype.FV = Math.pow(2, BI_FP);
        BigInteger.prototype.F1 = BI_FP - dbits;
        BigInteger.prototype.F2 = 2 * dbits - BI_FP;
        var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
        var BI_RC = new Array();
        var rr, vv;
        rr = "0".charCodeAt(0);
        for (vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
        rr = "a".charCodeAt(0);
        for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
        rr = "A".charCodeAt(0);
        for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
        function int2char(n) {
          return BI_RM.charAt(n);
        }
        function intAt(s, i) {
          var c = BI_RC[s.charCodeAt(i)];
          return c == null ? -1 : c;
        }
        function bnpCopyTo(r) {
          for (var i = this.t - 1; i >= 0; --i) r[i] = this[i];
          r.t = this.t;
          r.s = this.s;
        }
        function bnpFromInt(x) {
          this.t = 1;
          this.s = x < 0 ? -1 : 0;
          if (x > 0) this[0] = x;
          else if (x < -1) this[0] = x + this.DV;
          else this.t = 0;
        }
        function nbv(i) {
          var r = nbi();
          r.fromInt(i);
          return r;
        }
        function bnpFromString(s, b) {
          var k;
          if (b == 16) k = 4;
          else if (b == 8) k = 3;
          else if (b == 256) k = 8;
          else if (b == 2) k = 1;
          else if (b == 32) k = 5;
          else if (b == 4) k = 2;
          else {
            this.fromRadix(s, b);
            return;
          }
          this.t = 0;
          this.s = 0;
          var i = s.length, mi = false, sh = 0;
          while (--i >= 0) {
            var x = k == 8 ? s[i] & 255 : intAt(s, i);
            if (x < 0) {
              if (s.charAt(i) == "-") mi = true;
              continue;
            }
            mi = false;
            if (sh == 0)
              this[this.t++] = x;
            else if (sh + k > this.DB) {
              this[this.t - 1] |= (x & (1 << this.DB - sh) - 1) << sh;
              this[this.t++] = x >> this.DB - sh;
            } else
              this[this.t - 1] |= x << sh;
            sh += k;
            if (sh >= this.DB) sh -= this.DB;
          }
          if (k == 8 && (s[0] & 128) != 0) {
            this.s = -1;
            if (sh > 0) this[this.t - 1] |= (1 << this.DB - sh) - 1 << sh;
          }
          this.clamp();
          if (mi) BigInteger.ZERO.subTo(this, this);
        }
        function bnpClamp() {
          var c = this.s & this.DM;
          while (this.t > 0 && this[this.t - 1] == c) --this.t;
        }
        function bnToString(b) {
          if (this.s < 0) return "-" + this.negate().toString(b);
          var k;
          if (b == 16) k = 4;
          else if (b == 8) k = 3;
          else if (b == 2) k = 1;
          else if (b == 32) k = 5;
          else if (b == 4) k = 2;
          else return this.toRadix(b);
          var km = (1 << k) - 1, d, m = false, r = "", i = this.t;
          var p = this.DB - i * this.DB % k;
          if (i-- > 0) {
            if (p < this.DB && (d = this[i] >> p) > 0) {
              m = true;
              r = int2char(d);
            }
            while (i >= 0) {
              if (p < k) {
                d = (this[i] & (1 << p) - 1) << k - p;
                d |= this[--i] >> (p += this.DB - k);
              } else {
                d = this[i] >> (p -= k) & km;
                if (p <= 0) {
                  p += this.DB;
                  --i;
                }
              }
              if (d > 0) m = true;
              if (m) r += int2char(d);
            }
          }
          return m ? r : "0";
        }
        function bnNegate() {
          var r = nbi();
          BigInteger.ZERO.subTo(this, r);
          return r;
        }
        function bnAbs() {
          return this.s < 0 ? this.negate() : this;
        }
        function bnCompareTo(a) {
          var r = this.s - a.s;
          if (r != 0) return r;
          var i = this.t;
          r = i - a.t;
          if (r != 0) return this.s < 0 ? -r : r;
          while (--i >= 0)
            if ((r = this[i] - a[i]) != 0) return r;
          return 0;
        }
        function nbits(x) {
          var r = 1, t;
          if ((t = x >>> 16) != 0) {
            x = t;
            r += 16;
          }
          if ((t = x >> 8) != 0) {
            x = t;
            r += 8;
          }
          if ((t = x >> 4) != 0) {
            x = t;
            r += 4;
          }
          if ((t = x >> 2) != 0) {
            x = t;
            r += 2;
          }
          if ((t = x >> 1) != 0) {
            x = t;
            r += 1;
          }
          return r;
        }
        function bnBitLength() {
          if (this.t <= 0) return 0;
          return this.DB * (this.t - 1) + nbits(this[this.t - 1] ^ this.s & this.DM);
        }
        function bnpDLShiftTo(n, r) {
          var i;
          for (i = this.t - 1; i >= 0; --i) r[i + n] = this[i];
          for (i = n - 1; i >= 0; --i) r[i] = 0;
          r.t = this.t + n;
          r.s = this.s;
        }
        function bnpDRShiftTo(n, r) {
          for (var i = n; i < this.t; ++i) r[i - n] = this[i];
          r.t = Math.max(this.t - n, 0);
          r.s = this.s;
        }
        function bnpLShiftTo(n, r) {
          var bs = n % this.DB;
          var cbs = this.DB - bs;
          var bm = (1 << cbs) - 1;
          var ds = Math.floor(n / this.DB), c = this.s << bs & this.DM, i;
          for (i = this.t - 1; i >= 0; --i) {
            r[i + ds + 1] = this[i] >> cbs | c;
            c = (this[i] & bm) << bs;
          }
          for (i = ds - 1; i >= 0; --i) r[i] = 0;
          r[ds] = c;
          r.t = this.t + ds + 1;
          r.s = this.s;
          r.clamp();
        }
        function bnpRShiftTo(n, r) {
          r.s = this.s;
          var ds = Math.floor(n / this.DB);
          if (ds >= this.t) {
            r.t = 0;
            return;
          }
          var bs = n % this.DB;
          var cbs = this.DB - bs;
          var bm = (1 << bs) - 1;
          r[0] = this[ds] >> bs;
          for (var i = ds + 1; i < this.t; ++i) {
            r[i - ds - 1] |= (this[i] & bm) << cbs;
            r[i - ds] = this[i] >> bs;
          }
          if (bs > 0) r[this.t - ds - 1] |= (this.s & bm) << cbs;
          r.t = this.t - ds;
          r.clamp();
        }
        function bnpSubTo(a, r) {
          var i = 0, c = 0, m = Math.min(a.t, this.t);
          while (i < m) {
            c += this[i] - a[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
          }
          if (a.t < this.t) {
            c -= a.s;
            while (i < this.t) {
              c += this[i];
              r[i++] = c & this.DM;
              c >>= this.DB;
            }
            c += this.s;
          } else {
            c += this.s;
            while (i < a.t) {
              c -= a[i];
              r[i++] = c & this.DM;
              c >>= this.DB;
            }
            c -= a.s;
          }
          r.s = c < 0 ? -1 : 0;
          if (c < -1) r[i++] = this.DV + c;
          else if (c > 0) r[i++] = c;
          r.t = i;
          r.clamp();
        }
        function bnpMultiplyTo(a, r) {
          var x = this.abs(), y = a.abs();
          var i = x.t;
          r.t = i + y.t;
          while (--i >= 0) r[i] = 0;
          for (i = 0; i < y.t; ++i) r[i + x.t] = x.am(0, y[i], r, i, 0, x.t);
          r.s = 0;
          r.clamp();
          if (this.s != a.s) BigInteger.ZERO.subTo(r, r);
        }
        function bnpSquareTo(r) {
          var x = this.abs();
          var i = r.t = 2 * x.t;
          while (--i >= 0) r[i] = 0;
          for (i = 0; i < x.t - 1; ++i) {
            var c = x.am(i, x[i], r, 2 * i, 0, 1);
            if ((r[i + x.t] += x.am(i + 1, 2 * x[i], r, 2 * i + 1, c, x.t - i - 1)) >= x.DV) {
              r[i + x.t] -= x.DV;
              r[i + x.t + 1] = 1;
            }
          }
          if (r.t > 0) r[r.t - 1] += x.am(i, x[i], r, 2 * i, 0, 1);
          r.s = 0;
          r.clamp();
        }
        function bnpDivRemTo(m, q, r) {
          var pm = m.abs();
          if (pm.t <= 0) return;
          var pt = this.abs();
          if (pt.t < pm.t) {
            if (q != null) q.fromInt(0);
            if (r != null) this.copyTo(r);
            return;
          }
          if (r == null) r = nbi();
          var y = nbi(), ts = this.s, ms = m.s;
          var nsh = this.DB - nbits(pm[pm.t - 1]);
          if (nsh > 0) {
            pm.lShiftTo(nsh, y);
            pt.lShiftTo(nsh, r);
          } else {
            pm.copyTo(y);
            pt.copyTo(r);
          }
          var ys = y.t;
          var y0 = y[ys - 1];
          if (y0 == 0) return;
          var yt = y0 * (1 << this.F1) + (ys > 1 ? y[ys - 2] >> this.F2 : 0);
          var d1 = this.FV / yt, d2 = (1 << this.F1) / yt, e = 1 << this.F2;
          var i = r.t, j = i - ys, t = q == null ? nbi() : q;
          y.dlShiftTo(j, t);
          if (r.compareTo(t) >= 0) {
            r[r.t++] = 1;
            r.subTo(t, r);
          }
          BigInteger.ONE.dlShiftTo(ys, t);
          t.subTo(y, y);
          while (y.t < ys) y[y.t++] = 0;
          while (--j >= 0) {
            var qd = r[--i] == y0 ? this.DM : Math.floor(r[i] * d1 + (r[i - 1] + e) * d2);
            if ((r[i] += y.am(0, qd, r, j, 0, ys)) < qd) {
              y.dlShiftTo(j, t);
              r.subTo(t, r);
              while (r[i] < --qd) r.subTo(t, r);
            }
          }
          if (q != null) {
            r.drShiftTo(ys, q);
            if (ts != ms) BigInteger.ZERO.subTo(q, q);
          }
          r.t = ys;
          r.clamp();
          if (nsh > 0) r.rShiftTo(nsh, r);
          if (ts < 0) BigInteger.ZERO.subTo(r, r);
        }
        function bnMod(a) {
          var r = nbi();
          this.abs().divRemTo(a, null, r);
          if (this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r, r);
          return r;
        }
        function Classic(m) {
          this.m = m;
        }
        function cConvert(x) {
          if (x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
          else return x;
        }
        function cRevert(x) {
          return x;
        }
        function cReduce(x) {
          x.divRemTo(this.m, null, x);
        }
        function cMulTo(x, y, r) {
          x.multiplyTo(y, r);
          this.reduce(r);
        }
        function cSqrTo(x, r) {
          x.squareTo(r);
          this.reduce(r);
        }
        Classic.prototype.convert = cConvert;
        Classic.prototype.revert = cRevert;
        Classic.prototype.reduce = cReduce;
        Classic.prototype.mulTo = cMulTo;
        Classic.prototype.sqrTo = cSqrTo;
        function bnpInvDigit() {
          if (this.t < 1) return 0;
          var x = this[0];
          if ((x & 1) == 0) return 0;
          var y = x & 3;
          y = y * (2 - (x & 15) * y) & 15;
          y = y * (2 - (x & 255) * y) & 255;
          y = y * (2 - ((x & 65535) * y & 65535)) & 65535;
          y = y * (2 - x * y % this.DV) % this.DV;
          return y > 0 ? this.DV - y : -y;
        }
        function Montgomery(m) {
          this.m = m;
          this.mp = m.invDigit();
          this.mpl = this.mp & 32767;
          this.mph = this.mp >> 15;
          this.um = (1 << m.DB - 15) - 1;
          this.mt2 = 2 * m.t;
        }
        function montConvert(x) {
          var r = nbi();
          x.abs().dlShiftTo(this.m.t, r);
          r.divRemTo(this.m, null, r);
          if (x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r, r);
          return r;
        }
        function montRevert(x) {
          var r = nbi();
          x.copyTo(r);
          this.reduce(r);
          return r;
        }
        function montReduce(x) {
          while (x.t <= this.mt2)
            x[x.t++] = 0;
          for (var i = 0; i < this.m.t; ++i) {
            var j = x[i] & 32767;
            var u0 = j * this.mpl + ((j * this.mph + (x[i] >> 15) * this.mpl & this.um) << 15) & x.DM;
            j = i + this.m.t;
            x[j] += this.m.am(0, u0, x, i, 0, this.m.t);
            while (x[j] >= x.DV) {
              x[j] -= x.DV;
              x[++j]++;
            }
          }
          x.clamp();
          x.drShiftTo(this.m.t, x);
          if (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
        }
        function montSqrTo(x, r) {
          x.squareTo(r);
          this.reduce(r);
        }
        function montMulTo(x, y, r) {
          x.multiplyTo(y, r);
          this.reduce(r);
        }
        Montgomery.prototype.convert = montConvert;
        Montgomery.prototype.revert = montRevert;
        Montgomery.prototype.reduce = montReduce;
        Montgomery.prototype.mulTo = montMulTo;
        Montgomery.prototype.sqrTo = montSqrTo;
        function bnpIsEven() {
          return (this.t > 0 ? this[0] & 1 : this.s) == 0;
        }
        function bnpExp(e, z) {
          if (e > 4294967295 || e < 1) return BigInteger.ONE;
          var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e) - 1;
          g.copyTo(r);
          while (--i >= 0) {
            z.sqrTo(r, r2);
            if ((e & 1 << i) > 0) z.mulTo(r2, g, r);
            else {
              var t = r;
              r = r2;
              r2 = t;
            }
          }
          return z.revert(r);
        }
        function bnModPowInt(e, m) {
          var z;
          if (e < 256 || m.isEven()) z = new Classic(m);
          else z = new Montgomery(m);
          return this.exp(e, z);
        }
        BigInteger.prototype.copyTo = bnpCopyTo;
        BigInteger.prototype.fromInt = bnpFromInt;
        BigInteger.prototype.fromString = bnpFromString;
        BigInteger.prototype.clamp = bnpClamp;
        BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
        BigInteger.prototype.drShiftTo = bnpDRShiftTo;
        BigInteger.prototype.lShiftTo = bnpLShiftTo;
        BigInteger.prototype.rShiftTo = bnpRShiftTo;
        BigInteger.prototype.subTo = bnpSubTo;
        BigInteger.prototype.multiplyTo = bnpMultiplyTo;
        BigInteger.prototype.squareTo = bnpSquareTo;
        BigInteger.prototype.divRemTo = bnpDivRemTo;
        BigInteger.prototype.invDigit = bnpInvDigit;
        BigInteger.prototype.isEven = bnpIsEven;
        BigInteger.prototype.exp = bnpExp;
        BigInteger.prototype.toString = bnToString;
        BigInteger.prototype.negate = bnNegate;
        BigInteger.prototype.abs = bnAbs;
        BigInteger.prototype.compareTo = bnCompareTo;
        BigInteger.prototype.bitLength = bnBitLength;
        BigInteger.prototype.mod = bnMod;
        BigInteger.prototype.modPowInt = bnModPowInt;
        BigInteger.ZERO = nbv(0);
        BigInteger.ONE = nbv(1);
        function bnClone() {
          var r = nbi();
          this.copyTo(r);
          return r;
        }
        function bnIntValue() {
          if (this.s < 0) {
            if (this.t == 1) return this[0] - this.DV;
            else if (this.t == 0) return -1;
          } else if (this.t == 1) return this[0];
          else if (this.t == 0) return 0;
          return (this[1] & (1 << 32 - this.DB) - 1) << this.DB | this[0];
        }
        function bnByteValue() {
          return this.t == 0 ? this.s : this[0] << 24 >> 24;
        }
        function bnShortValue() {
          return this.t == 0 ? this.s : this[0] << 16 >> 16;
        }
        function bnpChunkSize(r) {
          return Math.floor(Math.LN2 * this.DB / Math.log(r));
        }
        function bnSigNum() {
          if (this.s < 0) return -1;
          else if (this.t <= 0 || this.t == 1 && this[0] <= 0) return 0;
          else return 1;
        }
        function bnpToRadix(b) {
          if (b == null) b = 10;
          if (this.signum() == 0 || b < 2 || b > 36) return "0";
          var cs = this.chunkSize(b);
          var a = Math.pow(b, cs);
          var d = nbv(a), y = nbi(), z = nbi(), r = "";
          this.divRemTo(d, y, z);
          while (y.signum() > 0) {
            r = (a + z.intValue()).toString(b).substr(1) + r;
            y.divRemTo(d, y, z);
          }
          return z.intValue().toString(b) + r;
        }
        function bnpFromRadix(s, b) {
          this.fromInt(0);
          if (b == null) b = 10;
          var cs = this.chunkSize(b);
          var d = Math.pow(b, cs), mi = false, j = 0, w = 0;
          for (var i = 0; i < s.length; ++i) {
            var x = intAt(s, i);
            if (x < 0) {
              if (s.charAt(i) == "-" && this.signum() == 0) mi = true;
              continue;
            }
            w = b * w + x;
            if (++j >= cs) {
              this.dMultiply(d);
              this.dAddOffset(w, 0);
              j = 0;
              w = 0;
            }
          }
          if (j > 0) {
            this.dMultiply(Math.pow(b, j));
            this.dAddOffset(w, 0);
          }
          if (mi) BigInteger.ZERO.subTo(this, this);
        }
        function bnpFromNumber(a, b, c) {
          if ("number" == typeof b) {
            if (a < 2) this.fromInt(1);
            else {
              this.fromNumber(a, c);
              if (!this.testBit(a - 1))
                this.bitwiseTo(BigInteger.ONE.shiftLeft(a - 1), op_or, this);
              if (this.isEven()) this.dAddOffset(1, 0);
              while (!this.isProbablePrime(b)) {
                this.dAddOffset(2, 0);
                if (this.bitLength() > a) this.subTo(BigInteger.ONE.shiftLeft(a - 1), this);
              }
            }
          } else {
            var x = new Array(), t = a & 7;
            x.length = (a >> 3) + 1;
            b.nextBytes(x);
            if (t > 0) x[0] &= (1 << t) - 1;
            else x[0] = 0;
            this.fromString(x, 256);
          }
        }
        function bnToByteArray() {
          var i = this.t, r = new Array();
          r[0] = this.s;
          var p = this.DB - i * this.DB % 8, d, k = 0;
          if (i-- > 0) {
            if (p < this.DB && (d = this[i] >> p) != (this.s & this.DM) >> p)
              r[k++] = d | this.s << this.DB - p;
            while (i >= 0) {
              if (p < 8) {
                d = (this[i] & (1 << p) - 1) << 8 - p;
                d |= this[--i] >> (p += this.DB - 8);
              } else {
                d = this[i] >> (p -= 8) & 255;
                if (p <= 0) {
                  p += this.DB;
                  --i;
                }
              }
              if ((d & 128) != 0) d |= -256;
              if (k == 0 && (this.s & 128) != (d & 128)) ++k;
              if (k > 0 || d != this.s) r[k++] = d;
            }
          }
          return r;
        }
        function bnEquals(a) {
          return this.compareTo(a) == 0;
        }
        function bnMin(a) {
          return this.compareTo(a) < 0 ? this : a;
        }
        function bnMax(a) {
          return this.compareTo(a) > 0 ? this : a;
        }
        function bnpBitwiseTo(a, op, r) {
          var i, f, m = Math.min(a.t, this.t);
          for (i = 0; i < m; ++i) r[i] = op(this[i], a[i]);
          if (a.t < this.t) {
            f = a.s & this.DM;
            for (i = m; i < this.t; ++i) r[i] = op(this[i], f);
            r.t = this.t;
          } else {
            f = this.s & this.DM;
            for (i = m; i < a.t; ++i) r[i] = op(f, a[i]);
            r.t = a.t;
          }
          r.s = op(this.s, a.s);
          r.clamp();
        }
        function op_and(x, y) {
          return x & y;
        }
        function bnAnd(a) {
          var r = nbi();
          this.bitwiseTo(a, op_and, r);
          return r;
        }
        function op_or(x, y) {
          return x | y;
        }
        function bnOr(a) {
          var r = nbi();
          this.bitwiseTo(a, op_or, r);
          return r;
        }
        function op_xor(x, y) {
          return x ^ y;
        }
        function bnXor(a) {
          var r = nbi();
          this.bitwiseTo(a, op_xor, r);
          return r;
        }
        function op_andnot(x, y) {
          return x & ~y;
        }
        function bnAndNot(a) {
          var r = nbi();
          this.bitwiseTo(a, op_andnot, r);
          return r;
        }
        function bnNot() {
          var r = nbi();
          for (var i = 0; i < this.t; ++i) r[i] = this.DM & ~this[i];
          r.t = this.t;
          r.s = ~this.s;
          return r;
        }
        function bnShiftLeft(n) {
          var r = nbi();
          if (n < 0) this.rShiftTo(-n, r);
          else this.lShiftTo(n, r);
          return r;
        }
        function bnShiftRight(n) {
          var r = nbi();
          if (n < 0) this.lShiftTo(-n, r);
          else this.rShiftTo(n, r);
          return r;
        }
        function lbit(x) {
          if (x == 0) return -1;
          var r = 0;
          if ((x & 65535) == 0) {
            x >>= 16;
            r += 16;
          }
          if ((x & 255) == 0) {
            x >>= 8;
            r += 8;
          }
          if ((x & 15) == 0) {
            x >>= 4;
            r += 4;
          }
          if ((x & 3) == 0) {
            x >>= 2;
            r += 2;
          }
          if ((x & 1) == 0) ++r;
          return r;
        }
        function bnGetLowestSetBit() {
          for (var i = 0; i < this.t; ++i)
            if (this[i] != 0) return i * this.DB + lbit(this[i]);
          if (this.s < 0) return this.t * this.DB;
          return -1;
        }
        function cbit(x) {
          var r = 0;
          while (x != 0) {
            x &= x - 1;
            ++r;
          }
          return r;
        }
        function bnBitCount() {
          var r = 0, x = this.s & this.DM;
          for (var i = 0; i < this.t; ++i) r += cbit(this[i] ^ x);
          return r;
        }
        function bnTestBit(n) {
          var j = Math.floor(n / this.DB);
          if (j >= this.t) return this.s != 0;
          return (this[j] & 1 << n % this.DB) != 0;
        }
        function bnpChangeBit(n, op) {
          var r = BigInteger.ONE.shiftLeft(n);
          this.bitwiseTo(r, op, r);
          return r;
        }
        function bnSetBit(n) {
          return this.changeBit(n, op_or);
        }
        function bnClearBit(n) {
          return this.changeBit(n, op_andnot);
        }
        function bnFlipBit(n) {
          return this.changeBit(n, op_xor);
        }
        function bnpAddTo(a, r) {
          var i = 0, c = 0, m = Math.min(a.t, this.t);
          while (i < m) {
            c += this[i] + a[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
          }
          if (a.t < this.t) {
            c += a.s;
            while (i < this.t) {
              c += this[i];
              r[i++] = c & this.DM;
              c >>= this.DB;
            }
            c += this.s;
          } else {
            c += this.s;
            while (i < a.t) {
              c += a[i];
              r[i++] = c & this.DM;
              c >>= this.DB;
            }
            c += a.s;
          }
          r.s = c < 0 ? -1 : 0;
          if (c > 0) r[i++] = c;
          else if (c < -1) r[i++] = this.DV + c;
          r.t = i;
          r.clamp();
        }
        function bnAdd(a) {
          var r = nbi();
          this.addTo(a, r);
          return r;
        }
        function bnSubtract(a) {
          var r = nbi();
          this.subTo(a, r);
          return r;
        }
        function bnMultiply(a) {
          var r = nbi();
          this.multiplyTo(a, r);
          return r;
        }
        function bnSquare() {
          var r = nbi();
          this.squareTo(r);
          return r;
        }
        function bnDivide(a) {
          var r = nbi();
          this.divRemTo(a, r, null);
          return r;
        }
        function bnRemainder(a) {
          var r = nbi();
          this.divRemTo(a, null, r);
          return r;
        }
        function bnDivideAndRemainder(a) {
          var q = nbi(), r = nbi();
          this.divRemTo(a, q, r);
          return new Array(q, r);
        }
        function bnpDMultiply(n) {
          this[this.t] = this.am(0, n - 1, this, 0, 0, this.t);
          ++this.t;
          this.clamp();
        }
        function bnpDAddOffset(n, w) {
          if (n == 0) return;
          while (this.t <= w) this[this.t++] = 0;
          this[w] += n;
          while (this[w] >= this.DV) {
            this[w] -= this.DV;
            if (++w >= this.t) this[this.t++] = 0;
            ++this[w];
          }
        }
        function NullExp() {
        }
        function nNop(x) {
          return x;
        }
        function nMulTo(x, y, r) {
          x.multiplyTo(y, r);
        }
        function nSqrTo(x, r) {
          x.squareTo(r);
        }
        NullExp.prototype.convert = nNop;
        NullExp.prototype.revert = nNop;
        NullExp.prototype.mulTo = nMulTo;
        NullExp.prototype.sqrTo = nSqrTo;
        function bnPow(e) {
          return this.exp(e, new NullExp());
        }
        function bnpMultiplyLowerTo(a, n, r) {
          var i = Math.min(this.t + a.t, n);
          r.s = 0;
          r.t = i;
          while (i > 0) r[--i] = 0;
          var j;
          for (j = r.t - this.t; i < j; ++i) r[i + this.t] = this.am(0, a[i], r, i, 0, this.t);
          for (j = Math.min(a.t, n); i < j; ++i) this.am(0, a[i], r, i, 0, n - i);
          r.clamp();
        }
        function bnpMultiplyUpperTo(a, n, r) {
          --n;
          var i = r.t = this.t + a.t - n;
          r.s = 0;
          while (--i >= 0) r[i] = 0;
          for (i = Math.max(n - this.t, 0); i < a.t; ++i)
            r[this.t + i - n] = this.am(n - i, a[i], r, 0, 0, this.t + i - n);
          r.clamp();
          r.drShiftTo(1, r);
        }
        function Barrett(m) {
          this.r2 = nbi();
          this.q3 = nbi();
          BigInteger.ONE.dlShiftTo(2 * m.t, this.r2);
          this.mu = this.r2.divide(m);
          this.m = m;
        }
        function barrettConvert(x) {
          if (x.s < 0 || x.t > 2 * this.m.t) return x.mod(this.m);
          else if (x.compareTo(this.m) < 0) return x;
          else {
            var r = nbi();
            x.copyTo(r);
            this.reduce(r);
            return r;
          }
        }
        function barrettRevert(x) {
          return x;
        }
        function barrettReduce(x) {
          x.drShiftTo(this.m.t - 1, this.r2);
          if (x.t > this.m.t + 1) {
            x.t = this.m.t + 1;
            x.clamp();
          }
          this.mu.multiplyUpperTo(this.r2, this.m.t + 1, this.q3);
          this.m.multiplyLowerTo(this.q3, this.m.t + 1, this.r2);
          while (x.compareTo(this.r2) < 0) x.dAddOffset(1, this.m.t + 1);
          x.subTo(this.r2, x);
          while (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
        }
        function barrettSqrTo(x, r) {
          x.squareTo(r);
          this.reduce(r);
        }
        function barrettMulTo(x, y, r) {
          x.multiplyTo(y, r);
          this.reduce(r);
        }
        Barrett.prototype.convert = barrettConvert;
        Barrett.prototype.revert = barrettRevert;
        Barrett.prototype.reduce = barrettReduce;
        Barrett.prototype.mulTo = barrettMulTo;
        Barrett.prototype.sqrTo = barrettSqrTo;
        function bnModPow(e, m) {
          var i = e.bitLength(), k, r = nbv(1), z;
          if (i <= 0) return r;
          else if (i < 18) k = 1;
          else if (i < 48) k = 3;
          else if (i < 144) k = 4;
          else if (i < 768) k = 5;
          else k = 6;
          if (i < 8)
            z = new Classic(m);
          else if (m.isEven())
            z = new Barrett(m);
          else
            z = new Montgomery(m);
          var g = new Array(), n = 3, k1 = k - 1, km = (1 << k) - 1;
          g[1] = z.convert(this);
          if (k > 1) {
            var g2 = nbi();
            z.sqrTo(g[1], g2);
            while (n <= km) {
              g[n] = nbi();
              z.mulTo(g2, g[n - 2], g[n]);
              n += 2;
            }
          }
          var j = e.t - 1, w, is1 = true, r2 = nbi(), t;
          i = nbits(e[j]) - 1;
          while (j >= 0) {
            if (i >= k1) w = e[j] >> i - k1 & km;
            else {
              w = (e[j] & (1 << i + 1) - 1) << k1 - i;
              if (j > 0) w |= e[j - 1] >> this.DB + i - k1;
            }
            n = k;
            while ((w & 1) == 0) {
              w >>= 1;
              --n;
            }
            if ((i -= n) < 0) {
              i += this.DB;
              --j;
            }
            if (is1) {
              g[w].copyTo(r);
              is1 = false;
            } else {
              while (n > 1) {
                z.sqrTo(r, r2);
                z.sqrTo(r2, r);
                n -= 2;
              }
              if (n > 0) z.sqrTo(r, r2);
              else {
                t = r;
                r = r2;
                r2 = t;
              }
              z.mulTo(r2, g[w], r);
            }
            while (j >= 0 && (e[j] & 1 << i) == 0) {
              z.sqrTo(r, r2);
              t = r;
              r = r2;
              r2 = t;
              if (--i < 0) {
                i = this.DB - 1;
                --j;
              }
            }
          }
          return z.revert(r);
        }
        function bnGCD(a) {
          var x = this.s < 0 ? this.negate() : this.clone();
          var y = a.s < 0 ? a.negate() : a.clone();
          if (x.compareTo(y) < 0) {
            var t = x;
            x = y;
            y = t;
          }
          var i = x.getLowestSetBit(), g = y.getLowestSetBit();
          if (g < 0) return x;
          if (i < g) g = i;
          if (g > 0) {
            x.rShiftTo(g, x);
            y.rShiftTo(g, y);
          }
          while (x.signum() > 0) {
            if ((i = x.getLowestSetBit()) > 0) x.rShiftTo(i, x);
            if ((i = y.getLowestSetBit()) > 0) y.rShiftTo(i, y);
            if (x.compareTo(y) >= 0) {
              x.subTo(y, x);
              x.rShiftTo(1, x);
            } else {
              y.subTo(x, y);
              y.rShiftTo(1, y);
            }
          }
          if (g > 0) y.lShiftTo(g, y);
          return y;
        }
        function bnpModInt(n) {
          if (n <= 0) return 0;
          var d = this.DV % n, r = this.s < 0 ? n - 1 : 0;
          if (this.t > 0)
            if (d == 0) r = this[0] % n;
            else
              for (var i = this.t - 1; i >= 0; --i) r = (d * r + this[i]) % n;
          return r;
        }
        function bnModInverse(m) {
          var ac = m.isEven();
          if (this.isEven() && ac || m.signum() == 0) return BigInteger.ZERO;
          var u = m.clone(), v = this.clone();
          var a = nbv(1), b = nbv(0), c = nbv(0), d = nbv(1);
          while (u.signum() != 0) {
            while (u.isEven()) {
              u.rShiftTo(1, u);
              if (ac) {
                if (!a.isEven() || !b.isEven()) {
                  a.addTo(this, a);
                  b.subTo(m, b);
                }
                a.rShiftTo(1, a);
              } else if (!b.isEven()) b.subTo(m, b);
              b.rShiftTo(1, b);
            }
            while (v.isEven()) {
              v.rShiftTo(1, v);
              if (ac) {
                if (!c.isEven() || !d.isEven()) {
                  c.addTo(this, c);
                  d.subTo(m, d);
                }
                c.rShiftTo(1, c);
              } else if (!d.isEven()) d.subTo(m, d);
              d.rShiftTo(1, d);
            }
            if (u.compareTo(v) >= 0) {
              u.subTo(v, u);
              if (ac) a.subTo(c, a);
              b.subTo(d, b);
            } else {
              v.subTo(u, v);
              if (ac) c.subTo(a, c);
              d.subTo(b, d);
            }
          }
          if (v.compareTo(BigInteger.ONE) != 0) return BigInteger.ZERO;
          if (d.compareTo(m) >= 0) return d.subtract(m);
          if (d.signum() < 0) d.addTo(m, d);
          else return d;
          if (d.signum() < 0) return d.add(m);
          else return d;
        }
        var lowprimes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421, 431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509, 521, 523, 541, 547, 557, 563, 569, 571, 577, 587, 593, 599, 601, 607, 613, 617, 619, 631, 641, 643, 647, 653, 659, 661, 673, 677, 683, 691, 701, 709, 719, 727, 733, 739, 743, 751, 757, 761, 769, 773, 787, 797, 809, 811, 821, 823, 827, 829, 839, 853, 857, 859, 863, 877, 881, 883, 887, 907, 911, 919, 929, 937, 941, 947, 953, 967, 971, 977, 983, 991, 997];
        var lplim = (1 << 26) / lowprimes[lowprimes.length - 1];
        function bnIsProbablePrime(t) {
          var i, x = this.abs();
          if (x.t == 1 && x[0] <= lowprimes[lowprimes.length - 1]) {
            for (i = 0; i < lowprimes.length; ++i)
              if (x[0] == lowprimes[i]) return true;
            return false;
          }
          if (x.isEven()) return false;
          i = 1;
          while (i < lowprimes.length) {
            var m = lowprimes[i], j = i + 1;
            while (j < lowprimes.length && m < lplim) m *= lowprimes[j++];
            m = x.modInt(m);
            while (i < j)
              if (m % lowprimes[i++] == 0) return false;
          }
          return x.millerRabin(t);
        }
        function bnpMillerRabin(t) {
          var n1 = this.subtract(BigInteger.ONE);
          var k = n1.getLowestSetBit();
          if (k <= 0) return false;
          var r = n1.shiftRight(k);
          t = t + 1 >> 1;
          if (t > lowprimes.length) t = lowprimes.length;
          var a = nbi();
          for (var i = 0; i < t; ++i) {
            a.fromInt(lowprimes[Math.floor(Math.random() * lowprimes.length)]);
            var y = a.modPow(r, this);
            if (y.compareTo(BigInteger.ONE) != 0 && y.compareTo(n1) != 0) {
              var j = 1;
              while (j++ < k && y.compareTo(n1) != 0) {
                y = y.modPowInt(2, this);
                if (y.compareTo(BigInteger.ONE) == 0) return false;
              }
              if (y.compareTo(n1) != 0) return false;
            }
          }
          return true;
        }
        BigInteger.prototype.chunkSize = bnpChunkSize;
        BigInteger.prototype.toRadix = bnpToRadix;
        BigInteger.prototype.fromRadix = bnpFromRadix;
        BigInteger.prototype.fromNumber = bnpFromNumber;
        BigInteger.prototype.bitwiseTo = bnpBitwiseTo;
        BigInteger.prototype.changeBit = bnpChangeBit;
        BigInteger.prototype.addTo = bnpAddTo;
        BigInteger.prototype.dMultiply = bnpDMultiply;
        BigInteger.prototype.dAddOffset = bnpDAddOffset;
        BigInteger.prototype.multiplyLowerTo = bnpMultiplyLowerTo;
        BigInteger.prototype.multiplyUpperTo = bnpMultiplyUpperTo;
        BigInteger.prototype.modInt = bnpModInt;
        BigInteger.prototype.millerRabin = bnpMillerRabin;
        BigInteger.prototype.clone = bnClone;
        BigInteger.prototype.intValue = bnIntValue;
        BigInteger.prototype.byteValue = bnByteValue;
        BigInteger.prototype.shortValue = bnShortValue;
        BigInteger.prototype.signum = bnSigNum;
        BigInteger.prototype.toByteArray = bnToByteArray;
        BigInteger.prototype.equals = bnEquals;
        BigInteger.prototype.min = bnMin;
        BigInteger.prototype.max = bnMax;
        BigInteger.prototype.and = bnAnd;
        BigInteger.prototype.or = bnOr;
        BigInteger.prototype.xor = bnXor;
        BigInteger.prototype.andNot = bnAndNot;
        BigInteger.prototype.not = bnNot;
        BigInteger.prototype.shiftLeft = bnShiftLeft;
        BigInteger.prototype.shiftRight = bnShiftRight;
        BigInteger.prototype.getLowestSetBit = bnGetLowestSetBit;
        BigInteger.prototype.bitCount = bnBitCount;
        BigInteger.prototype.testBit = bnTestBit;
        BigInteger.prototype.setBit = bnSetBit;
        BigInteger.prototype.clearBit = bnClearBit;
        BigInteger.prototype.flipBit = bnFlipBit;
        BigInteger.prototype.add = bnAdd;
        BigInteger.prototype.subtract = bnSubtract;
        BigInteger.prototype.multiply = bnMultiply;
        BigInteger.prototype.divide = bnDivide;
        BigInteger.prototype.remainder = bnRemainder;
        BigInteger.prototype.divideAndRemainder = bnDivideAndRemainder;
        BigInteger.prototype.modPow = bnModPow;
        BigInteger.prototype.modInverse = bnModInverse;
        BigInteger.prototype.pow = bnPow;
        BigInteger.prototype.gcd = bnGCD;
        BigInteger.prototype.isProbablePrime = bnIsProbablePrime;
        BigInteger.prototype.square = bnSquare;
        var Int128 = BigInteger;
        Int128.prototype.IsNegative = function() {
          if (this.compareTo(Int128.ZERO) == -1) return true;
          else return false;
        };
        Int128.op_Equality = function(val1, val2) {
          if (val1.compareTo(val2) == 0) return true;
          else return false;
        };
        Int128.op_Inequality = function(val1, val2) {
          if (val1.compareTo(val2) != 0) return true;
          else return false;
        };
        Int128.op_GreaterThan = function(val1, val2) {
          if (val1.compareTo(val2) > 0) return true;
          else return false;
        };
        Int128.op_LessThan = function(val1, val2) {
          if (val1.compareTo(val2) < 0) return true;
          else return false;
        };
        Int128.op_Addition = function(lhs, rhs) {
          return new Int128(lhs, void 0, void 0).add(new Int128(rhs, void 0, void 0));
        };
        Int128.op_Subtraction = function(lhs, rhs) {
          return new Int128(lhs, void 0, void 0).subtract(new Int128(rhs, void 0, void 0));
        };
        Int128.Int128Mul = function(lhs, rhs) {
          return new Int128(lhs, void 0, void 0).multiply(new Int128(rhs, void 0, void 0));
        };
        Int128.op_Division = function(lhs, rhs) {
          return lhs.divide(rhs);
        };
        Int128.prototype.ToDouble = function() {
          return parseFloat(this.toString());
        };
        var Inherit = function(ce, ce2) {
          var p;
          if (typeof Object.getOwnPropertyNames === "undefined") {
            for (p in ce2.prototype)
              if (typeof ce.prototype[p] === "undefined" || ce.prototype[p] === Object.prototype[p]) ce.prototype[p] = ce2.prototype[p];
            for (p in ce2)
              if (typeof ce[p] === "undefined") ce[p] = ce2[p];
            ce.$baseCtor = ce2;
          } else {
            var props = Object.getOwnPropertyNames(ce2.prototype);
            for (var i = 0; i < props.length; i++)
              if (typeof Object.getOwnPropertyDescriptor(ce.prototype, props[i]) === "undefined") Object.defineProperty(ce.prototype, props[i], Object.getOwnPropertyDescriptor(ce2.prototype, props[i]));
            for (p in ce2)
              if (typeof ce[p] === "undefined") ce[p] = ce2[p];
            ce.$baseCtor = ce2;
          }
        };
        ClipperLib2.Path = function() {
          return [];
        };
        ClipperLib2.Path.prototype.push = Array.prototype.push;
        ClipperLib2.Paths = function() {
          return [];
        };
        ClipperLib2.Paths.prototype.push = Array.prototype.push;
        ClipperLib2.DoublePoint = function() {
          var a = arguments;
          this.X = 0;
          this.Y = 0;
          if (a.length === 1) {
            this.X = a[0].X;
            this.Y = a[0].Y;
          } else if (a.length === 2) {
            this.X = a[0];
            this.Y = a[1];
          }
        };
        ClipperLib2.DoublePoint0 = function() {
          this.X = 0;
          this.Y = 0;
        };
        ClipperLib2.DoublePoint0.prototype = ClipperLib2.DoublePoint.prototype;
        ClipperLib2.DoublePoint1 = function(dp) {
          this.X = dp.X;
          this.Y = dp.Y;
        };
        ClipperLib2.DoublePoint1.prototype = ClipperLib2.DoublePoint.prototype;
        ClipperLib2.DoublePoint2 = function(x, y) {
          this.X = x;
          this.Y = y;
        };
        ClipperLib2.DoublePoint2.prototype = ClipperLib2.DoublePoint.prototype;
        ClipperLib2.PolyNode = function() {
          this.m_Parent = null;
          this.m_polygon = new ClipperLib2.Path();
          this.m_Index = 0;
          this.m_jointype = 0;
          this.m_endtype = 0;
          this.m_Childs = [];
          this.IsOpen = false;
        };
        ClipperLib2.PolyNode.prototype.IsHoleNode = function() {
          var result = true;
          var node = this.m_Parent;
          while (node !== null) {
            result = !result;
            node = node.m_Parent;
          }
          return result;
        };
        ClipperLib2.PolyNode.prototype.ChildCount = function() {
          return this.m_Childs.length;
        };
        ClipperLib2.PolyNode.prototype.Contour = function() {
          return this.m_polygon;
        };
        ClipperLib2.PolyNode.prototype.AddChild = function(Child) {
          var cnt = this.m_Childs.length;
          this.m_Childs.push(Child);
          Child.m_Parent = this;
          Child.m_Index = cnt;
        };
        ClipperLib2.PolyNode.prototype.GetNext = function() {
          if (this.m_Childs.length > 0)
            return this.m_Childs[0];
          else
            return this.GetNextSiblingUp();
        };
        ClipperLib2.PolyNode.prototype.GetNextSiblingUp = function() {
          if (this.m_Parent === null)
            return null;
          else if (this.m_Index === this.m_Parent.m_Childs.length - 1)
            return this.m_Parent.GetNextSiblingUp();
          else
            return this.m_Parent.m_Childs[this.m_Index + 1];
        };
        ClipperLib2.PolyNode.prototype.Childs = function() {
          return this.m_Childs;
        };
        ClipperLib2.PolyNode.prototype.Parent = function() {
          return this.m_Parent;
        };
        ClipperLib2.PolyNode.prototype.IsHole = function() {
          return this.IsHoleNode();
        };
        ClipperLib2.PolyTree = function() {
          this.m_AllPolys = [];
          ClipperLib2.PolyNode.call(this);
        };
        ClipperLib2.PolyTree.prototype.Clear = function() {
          for (var i = 0, ilen = this.m_AllPolys.length; i < ilen; i++)
            this.m_AllPolys[i] = null;
          this.m_AllPolys.length = 0;
          this.m_Childs.length = 0;
        };
        ClipperLib2.PolyTree.prototype.GetFirst = function() {
          if (this.m_Childs.length > 0)
            return this.m_Childs[0];
          else
            return null;
        };
        ClipperLib2.PolyTree.prototype.Total = function() {
          var result = this.m_AllPolys.length;
          if (result > 0 && this.m_Childs[0] !== this.m_AllPolys[0]) result--;
          return result;
        };
        Inherit(ClipperLib2.PolyTree, ClipperLib2.PolyNode);
        ClipperLib2.Math_Abs_Int64 = ClipperLib2.Math_Abs_Int32 = ClipperLib2.Math_Abs_Double = function(a) {
          return Math.abs(a);
        };
        ClipperLib2.Math_Max_Int32_Int32 = function(a, b) {
          return Math.max(a, b);
        };
        if (browser.msie || browser.opera || browser.safari) ClipperLib2.Cast_Int32 = function(a) {
          return a | 0;
        };
        else ClipperLib2.Cast_Int32 = function(a) {
          return ~~a;
        };
        if (typeof Number.toInteger === "undefined")
          Number.toInteger = null;
        if (browser.chrome) ClipperLib2.Cast_Int64 = function(a) {
          if (a < -2147483648 || a > 2147483647)
            return a < 0 ? Math.ceil(a) : Math.floor(a);
          else return ~~a;
        };
        else if (browser.firefox && typeof Number.toInteger === "function") ClipperLib2.Cast_Int64 = function(a) {
          return Number.toInteger(a);
        };
        else if (browser.msie7 || browser.msie8) ClipperLib2.Cast_Int64 = function(a) {
          return parseInt(a, 10);
        };
        else if (browser.msie) ClipperLib2.Cast_Int64 = function(a) {
          if (a < -2147483648 || a > 2147483647)
            return a < 0 ? Math.ceil(a) : Math.floor(a);
          return a | 0;
        };
        else ClipperLib2.Cast_Int64 = function(a) {
          return a < 0 ? Math.ceil(a) : Math.floor(a);
        };
        ClipperLib2.Clear = function(a) {
          a.length = 0;
        };
        ClipperLib2.PI = 3.141592653589793;
        ClipperLib2.PI2 = 2 * 3.141592653589793;
        ClipperLib2.IntPoint = function() {
          var a = arguments, alen = a.length;
          this.X = 0;
          this.Y = 0;
          if (ClipperLib2.use_xyz) {
            this.Z = 0;
            if (alen === 3) {
              this.X = a[0];
              this.Y = a[1];
              this.Z = a[2];
            } else if (alen === 2) {
              this.X = a[0];
              this.Y = a[1];
              this.Z = 0;
            } else if (alen === 1) {
              if (a[0] instanceof ClipperLib2.DoublePoint) {
                var dp = a[0];
                this.X = ClipperLib2.Clipper.Round(dp.X);
                this.Y = ClipperLib2.Clipper.Round(dp.Y);
                this.Z = 0;
              } else {
                var pt = a[0];
                if (typeof pt.Z === "undefined") pt.Z = 0;
                this.X = pt.X;
                this.Y = pt.Y;
                this.Z = pt.Z;
              }
            } else {
              this.X = 0;
              this.Y = 0;
              this.Z = 0;
            }
          } else {
            if (alen === 2) {
              this.X = a[0];
              this.Y = a[1];
            } else if (alen === 1) {
              if (a[0] instanceof ClipperLib2.DoublePoint) {
                var dp = a[0];
                this.X = ClipperLib2.Clipper.Round(dp.X);
                this.Y = ClipperLib2.Clipper.Round(dp.Y);
              } else {
                var pt = a[0];
                this.X = pt.X;
                this.Y = pt.Y;
              }
            } else {
              this.X = 0;
              this.Y = 0;
            }
          }
        };
        ClipperLib2.IntPoint.op_Equality = function(a, b) {
          return a.X === b.X && a.Y === b.Y;
        };
        ClipperLib2.IntPoint.op_Inequality = function(a, b) {
          return a.X !== b.X || a.Y !== b.Y;
        };
        ClipperLib2.IntPoint0 = function() {
          this.X = 0;
          this.Y = 0;
          if (ClipperLib2.use_xyz)
            this.Z = 0;
        };
        ClipperLib2.IntPoint0.prototype = ClipperLib2.IntPoint.prototype;
        ClipperLib2.IntPoint1 = function(pt) {
          this.X = pt.X;
          this.Y = pt.Y;
          if (ClipperLib2.use_xyz) {
            if (typeof pt.Z === "undefined") this.Z = 0;
            else this.Z = pt.Z;
          }
        };
        ClipperLib2.IntPoint1.prototype = ClipperLib2.IntPoint.prototype;
        ClipperLib2.IntPoint1dp = function(dp) {
          this.X = ClipperLib2.Clipper.Round(dp.X);
          this.Y = ClipperLib2.Clipper.Round(dp.Y);
          if (ClipperLib2.use_xyz)
            this.Z = 0;
        };
        ClipperLib2.IntPoint1dp.prototype = ClipperLib2.IntPoint.prototype;
        ClipperLib2.IntPoint2 = function(x, y, z) {
          this.X = x;
          this.Y = y;
          if (ClipperLib2.use_xyz) {
            if (typeof z === "undefined") this.Z = 0;
            else this.Z = z;
          }
        };
        ClipperLib2.IntPoint2.prototype = ClipperLib2.IntPoint.prototype;
        ClipperLib2.IntRect = function() {
          var a = arguments, alen = a.length;
          if (alen === 4) {
            this.left = a[0];
            this.top = a[1];
            this.right = a[2];
            this.bottom = a[3];
          } else if (alen === 1) {
            var ir = a[0];
            this.left = ir.left;
            this.top = ir.top;
            this.right = ir.right;
            this.bottom = ir.bottom;
          } else {
            this.left = 0;
            this.top = 0;
            this.right = 0;
            this.bottom = 0;
          }
        };
        ClipperLib2.IntRect0 = function() {
          this.left = 0;
          this.top = 0;
          this.right = 0;
          this.bottom = 0;
        };
        ClipperLib2.IntRect0.prototype = ClipperLib2.IntRect.prototype;
        ClipperLib2.IntRect1 = function(ir) {
          this.left = ir.left;
          this.top = ir.top;
          this.right = ir.right;
          this.bottom = ir.bottom;
        };
        ClipperLib2.IntRect1.prototype = ClipperLib2.IntRect.prototype;
        ClipperLib2.IntRect4 = function(l, t, r, b) {
          this.left = l;
          this.top = t;
          this.right = r;
          this.bottom = b;
        };
        ClipperLib2.IntRect4.prototype = ClipperLib2.IntRect.prototype;
        ClipperLib2.ClipType = {
          ctIntersection: 0,
          ctUnion: 1,
          ctDifference: 2,
          ctXor: 3
        };
        ClipperLib2.PolyType = {
          ptSubject: 0,
          ptClip: 1
        };
        ClipperLib2.PolyFillType = {
          pftEvenOdd: 0,
          pftNonZero: 1,
          pftPositive: 2,
          pftNegative: 3
        };
        ClipperLib2.JoinType = {
          jtSquare: 0,
          jtRound: 1,
          jtMiter: 2
        };
        ClipperLib2.EndType = {
          etOpenSquare: 0,
          etOpenRound: 1,
          etOpenButt: 2,
          etClosedLine: 3,
          etClosedPolygon: 4
        };
        ClipperLib2.EdgeSide = {
          esLeft: 0,
          esRight: 1
        };
        ClipperLib2.Direction = {
          dRightToLeft: 0,
          dLeftToRight: 1
        };
        ClipperLib2.TEdge = function() {
          this.Bot = new ClipperLib2.IntPoint0();
          this.Curr = new ClipperLib2.IntPoint0();
          this.Top = new ClipperLib2.IntPoint0();
          this.Delta = new ClipperLib2.IntPoint0();
          this.Dx = 0;
          this.PolyTyp = ClipperLib2.PolyType.ptSubject;
          this.Side = ClipperLib2.EdgeSide.esLeft;
          this.WindDelta = 0;
          this.WindCnt = 0;
          this.WindCnt2 = 0;
          this.OutIdx = 0;
          this.Next = null;
          this.Prev = null;
          this.NextInLML = null;
          this.NextInAEL = null;
          this.PrevInAEL = null;
          this.NextInSEL = null;
          this.PrevInSEL = null;
        };
        ClipperLib2.IntersectNode = function() {
          this.Edge1 = null;
          this.Edge2 = null;
          this.Pt = new ClipperLib2.IntPoint0();
        };
        ClipperLib2.MyIntersectNodeSort = function() {
        };
        ClipperLib2.MyIntersectNodeSort.Compare = function(node1, node2) {
          var i = node2.Pt.Y - node1.Pt.Y;
          if (i > 0) return 1;
          else if (i < 0) return -1;
          else return 0;
        };
        ClipperLib2.LocalMinima = function() {
          this.Y = 0;
          this.LeftBound = null;
          this.RightBound = null;
          this.Next = null;
        };
        ClipperLib2.Scanbeam = function() {
          this.Y = 0;
          this.Next = null;
        };
        ClipperLib2.Maxima = function() {
          this.X = 0;
          this.Next = null;
          this.Prev = null;
        };
        ClipperLib2.OutRec = function() {
          this.Idx = 0;
          this.IsHole = false;
          this.IsOpen = false;
          this.FirstLeft = null;
          this.Pts = null;
          this.BottomPt = null;
          this.PolyNode = null;
        };
        ClipperLib2.OutPt = function() {
          this.Idx = 0;
          this.Pt = new ClipperLib2.IntPoint0();
          this.Next = null;
          this.Prev = null;
        };
        ClipperLib2.Join = function() {
          this.OutPt1 = null;
          this.OutPt2 = null;
          this.OffPt = new ClipperLib2.IntPoint0();
        };
        ClipperLib2.ClipperBase = function() {
          this.m_MinimaList = null;
          this.m_CurrentLM = null;
          this.m_edges = new Array();
          this.m_UseFullRange = false;
          this.m_HasOpenPaths = false;
          this.PreserveCollinear = false;
          this.m_Scanbeam = null;
          this.m_PolyOuts = null;
          this.m_ActiveEdges = null;
        };
        ClipperLib2.ClipperBase.horizontal = -9007199254740992;
        ClipperLib2.ClipperBase.Skip = -2;
        ClipperLib2.ClipperBase.Unassigned = -1;
        ClipperLib2.ClipperBase.tolerance = 1e-20;
        ClipperLib2.ClipperBase.loRange = 47453132;
        ClipperLib2.ClipperBase.hiRange = 4503599627370495;
        ClipperLib2.ClipperBase.near_zero = function(val) {
          return val > -ClipperLib2.ClipperBase.tolerance && val < ClipperLib2.ClipperBase.tolerance;
        };
        ClipperLib2.ClipperBase.IsHorizontal = function(e) {
          return e.Delta.Y === 0;
        };
        ClipperLib2.ClipperBase.prototype.PointIsVertex = function(pt, pp) {
          var pp2 = pp;
          do {
            if (ClipperLib2.IntPoint.op_Equality(pp2.Pt, pt))
              return true;
            pp2 = pp2.Next;
          } while (pp2 !== pp);
          return false;
        };
        ClipperLib2.ClipperBase.prototype.PointOnLineSegment = function(pt, linePt1, linePt2, UseFullRange) {
          if (UseFullRange)
            return pt.X === linePt1.X && pt.Y === linePt1.Y || pt.X === linePt2.X && pt.Y === linePt2.Y || pt.X > linePt1.X === pt.X < linePt2.X && pt.Y > linePt1.Y === pt.Y < linePt2.Y && Int128.op_Equality(
              Int128.Int128Mul(pt.X - linePt1.X, linePt2.Y - linePt1.Y),
              Int128.Int128Mul(linePt2.X - linePt1.X, pt.Y - linePt1.Y)
            );
          else
            return pt.X === linePt1.X && pt.Y === linePt1.Y || pt.X === linePt2.X && pt.Y === linePt2.Y || pt.X > linePt1.X === pt.X < linePt2.X && pt.Y > linePt1.Y === pt.Y < linePt2.Y && (pt.X - linePt1.X) * (linePt2.Y - linePt1.Y) === (linePt2.X - linePt1.X) * (pt.Y - linePt1.Y);
        };
        ClipperLib2.ClipperBase.prototype.PointOnPolygon = function(pt, pp, UseFullRange) {
          var pp2 = pp;
          while (true) {
            if (this.PointOnLineSegment(pt, pp2.Pt, pp2.Next.Pt, UseFullRange))
              return true;
            pp2 = pp2.Next;
            if (pp2 === pp)
              break;
          }
          return false;
        };
        ClipperLib2.ClipperBase.prototype.SlopesEqual = ClipperLib2.ClipperBase.SlopesEqual = function() {
          var a = arguments, alen = a.length;
          var e1, e2, pt1, pt2, pt3, pt4, UseFullRange;
          if (alen === 3) {
            e1 = a[0];
            e2 = a[1];
            UseFullRange = a[2];
            if (UseFullRange)
              return Int128.op_Equality(Int128.Int128Mul(e1.Delta.Y, e2.Delta.X), Int128.Int128Mul(e1.Delta.X, e2.Delta.Y));
            else
              return ClipperLib2.Cast_Int64(e1.Delta.Y * e2.Delta.X) === ClipperLib2.Cast_Int64(e1.Delta.X * e2.Delta.Y);
          } else if (alen === 4) {
            pt1 = a[0];
            pt2 = a[1];
            pt3 = a[2];
            UseFullRange = a[3];
            if (UseFullRange)
              return Int128.op_Equality(Int128.Int128Mul(pt1.Y - pt2.Y, pt2.X - pt3.X), Int128.Int128Mul(pt1.X - pt2.X, pt2.Y - pt3.Y));
            else
              return ClipperLib2.Cast_Int64((pt1.Y - pt2.Y) * (pt2.X - pt3.X)) - ClipperLib2.Cast_Int64((pt1.X - pt2.X) * (pt2.Y - pt3.Y)) === 0;
          } else {
            pt1 = a[0];
            pt2 = a[1];
            pt3 = a[2];
            pt4 = a[3];
            UseFullRange = a[4];
            if (UseFullRange)
              return Int128.op_Equality(Int128.Int128Mul(pt1.Y - pt2.Y, pt3.X - pt4.X), Int128.Int128Mul(pt1.X - pt2.X, pt3.Y - pt4.Y));
            else
              return ClipperLib2.Cast_Int64((pt1.Y - pt2.Y) * (pt3.X - pt4.X)) - ClipperLib2.Cast_Int64((pt1.X - pt2.X) * (pt3.Y - pt4.Y)) === 0;
          }
        };
        ClipperLib2.ClipperBase.SlopesEqual3 = function(e1, e2, UseFullRange) {
          if (UseFullRange)
            return Int128.op_Equality(Int128.Int128Mul(e1.Delta.Y, e2.Delta.X), Int128.Int128Mul(e1.Delta.X, e2.Delta.Y));
          else
            return ClipperLib2.Cast_Int64(e1.Delta.Y * e2.Delta.X) === ClipperLib2.Cast_Int64(e1.Delta.X * e2.Delta.Y);
        };
        ClipperLib2.ClipperBase.SlopesEqual4 = function(pt1, pt2, pt3, UseFullRange) {
          if (UseFullRange)
            return Int128.op_Equality(Int128.Int128Mul(pt1.Y - pt2.Y, pt2.X - pt3.X), Int128.Int128Mul(pt1.X - pt2.X, pt2.Y - pt3.Y));
          else
            return ClipperLib2.Cast_Int64((pt1.Y - pt2.Y) * (pt2.X - pt3.X)) - ClipperLib2.Cast_Int64((pt1.X - pt2.X) * (pt2.Y - pt3.Y)) === 0;
        };
        ClipperLib2.ClipperBase.SlopesEqual5 = function(pt1, pt2, pt3, pt4, UseFullRange) {
          if (UseFullRange)
            return Int128.op_Equality(Int128.Int128Mul(pt1.Y - pt2.Y, pt3.X - pt4.X), Int128.Int128Mul(pt1.X - pt2.X, pt3.Y - pt4.Y));
          else
            return ClipperLib2.Cast_Int64((pt1.Y - pt2.Y) * (pt3.X - pt4.X)) - ClipperLib2.Cast_Int64((pt1.X - pt2.X) * (pt3.Y - pt4.Y)) === 0;
        };
        ClipperLib2.ClipperBase.prototype.Clear = function() {
          this.DisposeLocalMinimaList();
          for (var i = 0, ilen = this.m_edges.length; i < ilen; ++i) {
            for (var j = 0, jlen = this.m_edges[i].length; j < jlen; ++j)
              this.m_edges[i][j] = null;
            ClipperLib2.Clear(this.m_edges[i]);
          }
          ClipperLib2.Clear(this.m_edges);
          this.m_UseFullRange = false;
          this.m_HasOpenPaths = false;
        };
        ClipperLib2.ClipperBase.prototype.DisposeLocalMinimaList = function() {
          while (this.m_MinimaList !== null) {
            var tmpLm = this.m_MinimaList.Next;
            this.m_MinimaList = null;
            this.m_MinimaList = tmpLm;
          }
          this.m_CurrentLM = null;
        };
        ClipperLib2.ClipperBase.prototype.RangeTest = function(Pt, useFullRange) {
          if (useFullRange.Value) {
            if (Pt.X > ClipperLib2.ClipperBase.hiRange || Pt.Y > ClipperLib2.ClipperBase.hiRange || -Pt.X > ClipperLib2.ClipperBase.hiRange || -Pt.Y > ClipperLib2.ClipperBase.hiRange)
              ClipperLib2.Error("Coordinate outside allowed range in RangeTest().");
          } else if (Pt.X > ClipperLib2.ClipperBase.loRange || Pt.Y > ClipperLib2.ClipperBase.loRange || -Pt.X > ClipperLib2.ClipperBase.loRange || -Pt.Y > ClipperLib2.ClipperBase.loRange) {
            useFullRange.Value = true;
            this.RangeTest(Pt, useFullRange);
          }
        };
        ClipperLib2.ClipperBase.prototype.InitEdge = function(e, eNext, ePrev, pt) {
          e.Next = eNext;
          e.Prev = ePrev;
          e.Curr.X = pt.X;
          e.Curr.Y = pt.Y;
          if (ClipperLib2.use_xyz) e.Curr.Z = pt.Z;
          e.OutIdx = -1;
        };
        ClipperLib2.ClipperBase.prototype.InitEdge2 = function(e, polyType) {
          if (e.Curr.Y >= e.Next.Curr.Y) {
            e.Bot.X = e.Curr.X;
            e.Bot.Y = e.Curr.Y;
            if (ClipperLib2.use_xyz) e.Bot.Z = e.Curr.Z;
            e.Top.X = e.Next.Curr.X;
            e.Top.Y = e.Next.Curr.Y;
            if (ClipperLib2.use_xyz) e.Top.Z = e.Next.Curr.Z;
          } else {
            e.Top.X = e.Curr.X;
            e.Top.Y = e.Curr.Y;
            if (ClipperLib2.use_xyz) e.Top.Z = e.Curr.Z;
            e.Bot.X = e.Next.Curr.X;
            e.Bot.Y = e.Next.Curr.Y;
            if (ClipperLib2.use_xyz) e.Bot.Z = e.Next.Curr.Z;
          }
          this.SetDx(e);
          e.PolyTyp = polyType;
        };
        ClipperLib2.ClipperBase.prototype.FindNextLocMin = function(E) {
          var E2;
          for (; ; ) {
            while (ClipperLib2.IntPoint.op_Inequality(E.Bot, E.Prev.Bot) || ClipperLib2.IntPoint.op_Equality(E.Curr, E.Top))
              E = E.Next;
            if (E.Dx !== ClipperLib2.ClipperBase.horizontal && E.Prev.Dx !== ClipperLib2.ClipperBase.horizontal)
              break;
            while (E.Prev.Dx === ClipperLib2.ClipperBase.horizontal)
              E = E.Prev;
            E2 = E;
            while (E.Dx === ClipperLib2.ClipperBase.horizontal)
              E = E.Next;
            if (E.Top.Y === E.Prev.Bot.Y)
              continue;
            if (E2.Prev.Bot.X < E.Bot.X)
              E = E2;
            break;
          }
          return E;
        };
        ClipperLib2.ClipperBase.prototype.ProcessBound = function(E, LeftBoundIsForward) {
          var EStart;
          var Result = E;
          var Horz;
          if (Result.OutIdx === ClipperLib2.ClipperBase.Skip) {
            E = Result;
            if (LeftBoundIsForward) {
              while (E.Top.Y === E.Next.Bot.Y) E = E.Next;
              while (E !== Result && E.Dx === ClipperLib2.ClipperBase.horizontal) E = E.Prev;
            } else {
              while (E.Top.Y === E.Prev.Bot.Y) E = E.Prev;
              while (E !== Result && E.Dx === ClipperLib2.ClipperBase.horizontal) E = E.Next;
            }
            if (E === Result) {
              if (LeftBoundIsForward) Result = E.Next;
              else Result = E.Prev;
            } else {
              if (LeftBoundIsForward)
                E = Result.Next;
              else
                E = Result.Prev;
              var locMin = new ClipperLib2.LocalMinima();
              locMin.Next = null;
              locMin.Y = E.Bot.Y;
              locMin.LeftBound = null;
              locMin.RightBound = E;
              E.WindDelta = 0;
              Result = this.ProcessBound(E, LeftBoundIsForward);
              this.InsertLocalMinima(locMin);
            }
            return Result;
          }
          if (E.Dx === ClipperLib2.ClipperBase.horizontal) {
            if (LeftBoundIsForward) EStart = E.Prev;
            else EStart = E.Next;
            if (EStart.Dx === ClipperLib2.ClipperBase.horizontal) {
              if (EStart.Bot.X !== E.Bot.X && EStart.Top.X !== E.Bot.X)
                this.ReverseHorizontal(E);
            } else if (EStart.Bot.X !== E.Bot.X)
              this.ReverseHorizontal(E);
          }
          EStart = E;
          if (LeftBoundIsForward) {
            while (Result.Top.Y === Result.Next.Bot.Y && Result.Next.OutIdx !== ClipperLib2.ClipperBase.Skip)
              Result = Result.Next;
            if (Result.Dx === ClipperLib2.ClipperBase.horizontal && Result.Next.OutIdx !== ClipperLib2.ClipperBase.Skip) {
              Horz = Result;
              while (Horz.Prev.Dx === ClipperLib2.ClipperBase.horizontal)
                Horz = Horz.Prev;
              if (Horz.Prev.Top.X > Result.Next.Top.X)
                Result = Horz.Prev;
            }
            while (E !== Result) {
              E.NextInLML = E.Next;
              if (E.Dx === ClipperLib2.ClipperBase.horizontal && E !== EStart && E.Bot.X !== E.Prev.Top.X)
                this.ReverseHorizontal(E);
              E = E.Next;
            }
            if (E.Dx === ClipperLib2.ClipperBase.horizontal && E !== EStart && E.Bot.X !== E.Prev.Top.X)
              this.ReverseHorizontal(E);
            Result = Result.Next;
          } else {
            while (Result.Top.Y === Result.Prev.Bot.Y && Result.Prev.OutIdx !== ClipperLib2.ClipperBase.Skip)
              Result = Result.Prev;
            if (Result.Dx === ClipperLib2.ClipperBase.horizontal && Result.Prev.OutIdx !== ClipperLib2.ClipperBase.Skip) {
              Horz = Result;
              while (Horz.Next.Dx === ClipperLib2.ClipperBase.horizontal)
                Horz = Horz.Next;
              if (Horz.Next.Top.X === Result.Prev.Top.X || Horz.Next.Top.X > Result.Prev.Top.X) {
                Result = Horz.Next;
              }
            }
            while (E !== Result) {
              E.NextInLML = E.Prev;
              if (E.Dx === ClipperLib2.ClipperBase.horizontal && E !== EStart && E.Bot.X !== E.Next.Top.X)
                this.ReverseHorizontal(E);
              E = E.Prev;
            }
            if (E.Dx === ClipperLib2.ClipperBase.horizontal && E !== EStart && E.Bot.X !== E.Next.Top.X)
              this.ReverseHorizontal(E);
            Result = Result.Prev;
          }
          return Result;
        };
        ClipperLib2.ClipperBase.prototype.AddPath = function(pg, polyType, Closed) {
          if (ClipperLib2.use_lines) {
            if (!Closed && polyType === ClipperLib2.PolyType.ptClip)
              ClipperLib2.Error("AddPath: Open paths must be subject.");
          } else {
            if (!Closed)
              ClipperLib2.Error("AddPath: Open paths have been disabled.");
          }
          var highI = pg.length - 1;
          if (Closed)
            while (highI > 0 && ClipperLib2.IntPoint.op_Equality(pg[highI], pg[0]))
              --highI;
          while (highI > 0 && ClipperLib2.IntPoint.op_Equality(pg[highI], pg[highI - 1]))
            --highI;
          if (Closed && highI < 2 || !Closed && highI < 1)
            return false;
          var edges = new Array();
          for (var i = 0; i <= highI; i++)
            edges.push(new ClipperLib2.TEdge());
          var IsFlat = true;
          edges[1].Curr.X = pg[1].X;
          edges[1].Curr.Y = pg[1].Y;
          if (ClipperLib2.use_xyz) edges[1].Curr.Z = pg[1].Z;
          var $1 = {
            Value: this.m_UseFullRange
          };
          this.RangeTest(pg[0], $1);
          this.m_UseFullRange = $1.Value;
          $1.Value = this.m_UseFullRange;
          this.RangeTest(pg[highI], $1);
          this.m_UseFullRange = $1.Value;
          this.InitEdge(edges[0], edges[1], edges[highI], pg[0]);
          this.InitEdge(edges[highI], edges[0], edges[highI - 1], pg[highI]);
          for (var i = highI - 1; i >= 1; --i) {
            $1.Value = this.m_UseFullRange;
            this.RangeTest(pg[i], $1);
            this.m_UseFullRange = $1.Value;
            this.InitEdge(edges[i], edges[i + 1], edges[i - 1], pg[i]);
          }
          var eStart = edges[0];
          var E = eStart, eLoopStop = eStart;
          for (; ; ) {
            if (E.Curr === E.Next.Curr && (Closed || E.Next !== eStart)) {
              if (E === E.Next)
                break;
              if (E === eStart)
                eStart = E.Next;
              E = this.RemoveEdge(E);
              eLoopStop = E;
              continue;
            }
            if (E.Prev === E.Next)
              break;
            else if (Closed && ClipperLib2.ClipperBase.SlopesEqual4(E.Prev.Curr, E.Curr, E.Next.Curr, this.m_UseFullRange) && (!this.PreserveCollinear || !this.Pt2IsBetweenPt1AndPt3(E.Prev.Curr, E.Curr, E.Next.Curr))) {
              if (E === eStart)
                eStart = E.Next;
              E = this.RemoveEdge(E);
              E = E.Prev;
              eLoopStop = E;
              continue;
            }
            E = E.Next;
            if (E === eLoopStop || !Closed && E.Next === eStart) break;
          }
          if (!Closed && E === E.Next || Closed && E.Prev === E.Next)
            return false;
          if (!Closed) {
            this.m_HasOpenPaths = true;
            eStart.Prev.OutIdx = ClipperLib2.ClipperBase.Skip;
          }
          E = eStart;
          do {
            this.InitEdge2(E, polyType);
            E = E.Next;
            if (IsFlat && E.Curr.Y !== eStart.Curr.Y)
              IsFlat = false;
          } while (E !== eStart);
          if (IsFlat) {
            if (Closed)
              return false;
            E.Prev.OutIdx = ClipperLib2.ClipperBase.Skip;
            var locMin = new ClipperLib2.LocalMinima();
            locMin.Next = null;
            locMin.Y = E.Bot.Y;
            locMin.LeftBound = null;
            locMin.RightBound = E;
            locMin.RightBound.Side = ClipperLib2.EdgeSide.esRight;
            locMin.RightBound.WindDelta = 0;
            for (; ; ) {
              if (E.Bot.X !== E.Prev.Top.X) this.ReverseHorizontal(E);
              if (E.Next.OutIdx === ClipperLib2.ClipperBase.Skip) break;
              E.NextInLML = E.Next;
              E = E.Next;
            }
            this.InsertLocalMinima(locMin);
            this.m_edges.push(edges);
            return true;
          }
          this.m_edges.push(edges);
          var leftBoundIsForward;
          var EMin = null;
          if (ClipperLib2.IntPoint.op_Equality(E.Prev.Bot, E.Prev.Top))
            E = E.Next;
          for (; ; ) {
            E = this.FindNextLocMin(E);
            if (E === EMin)
              break;
            else if (EMin === null)
              EMin = E;
            var locMin = new ClipperLib2.LocalMinima();
            locMin.Next = null;
            locMin.Y = E.Bot.Y;
            if (E.Dx < E.Prev.Dx) {
              locMin.LeftBound = E.Prev;
              locMin.RightBound = E;
              leftBoundIsForward = false;
            } else {
              locMin.LeftBound = E;
              locMin.RightBound = E.Prev;
              leftBoundIsForward = true;
            }
            locMin.LeftBound.Side = ClipperLib2.EdgeSide.esLeft;
            locMin.RightBound.Side = ClipperLib2.EdgeSide.esRight;
            if (!Closed)
              locMin.LeftBound.WindDelta = 0;
            else if (locMin.LeftBound.Next === locMin.RightBound)
              locMin.LeftBound.WindDelta = -1;
            else
              locMin.LeftBound.WindDelta = 1;
            locMin.RightBound.WindDelta = -locMin.LeftBound.WindDelta;
            E = this.ProcessBound(locMin.LeftBound, leftBoundIsForward);
            if (E.OutIdx === ClipperLib2.ClipperBase.Skip)
              E = this.ProcessBound(E, leftBoundIsForward);
            var E2 = this.ProcessBound(locMin.RightBound, !leftBoundIsForward);
            if (E2.OutIdx === ClipperLib2.ClipperBase.Skip) E2 = this.ProcessBound(E2, !leftBoundIsForward);
            if (locMin.LeftBound.OutIdx === ClipperLib2.ClipperBase.Skip)
              locMin.LeftBound = null;
            else if (locMin.RightBound.OutIdx === ClipperLib2.ClipperBase.Skip)
              locMin.RightBound = null;
            this.InsertLocalMinima(locMin);
            if (!leftBoundIsForward)
              E = E2;
          }
          return true;
        };
        ClipperLib2.ClipperBase.prototype.AddPaths = function(ppg, polyType, closed) {
          var result = false;
          for (var i = 0, ilen = ppg.length; i < ilen; ++i)
            if (this.AddPath(ppg[i], polyType, closed))
              result = true;
          return result;
        };
        ClipperLib2.ClipperBase.prototype.Pt2IsBetweenPt1AndPt3 = function(pt1, pt2, pt3) {
          if (ClipperLib2.IntPoint.op_Equality(pt1, pt3) || ClipperLib2.IntPoint.op_Equality(pt1, pt2) || ClipperLib2.IntPoint.op_Equality(pt3, pt2))
            return false;
          else if (pt1.X !== pt3.X)
            return pt2.X > pt1.X === pt2.X < pt3.X;
          else
            return pt2.Y > pt1.Y === pt2.Y < pt3.Y;
        };
        ClipperLib2.ClipperBase.prototype.RemoveEdge = function(e) {
          e.Prev.Next = e.Next;
          e.Next.Prev = e.Prev;
          var result = e.Next;
          e.Prev = null;
          return result;
        };
        ClipperLib2.ClipperBase.prototype.SetDx = function(e) {
          e.Delta.X = e.Top.X - e.Bot.X;
          e.Delta.Y = e.Top.Y - e.Bot.Y;
          if (e.Delta.Y === 0) e.Dx = ClipperLib2.ClipperBase.horizontal;
          else e.Dx = e.Delta.X / e.Delta.Y;
        };
        ClipperLib2.ClipperBase.prototype.InsertLocalMinima = function(newLm) {
          if (this.m_MinimaList === null) {
            this.m_MinimaList = newLm;
          } else if (newLm.Y >= this.m_MinimaList.Y) {
            newLm.Next = this.m_MinimaList;
            this.m_MinimaList = newLm;
          } else {
            var tmpLm = this.m_MinimaList;
            while (tmpLm.Next !== null && newLm.Y < tmpLm.Next.Y)
              tmpLm = tmpLm.Next;
            newLm.Next = tmpLm.Next;
            tmpLm.Next = newLm;
          }
        };
        ClipperLib2.ClipperBase.prototype.PopLocalMinima = function(Y, current) {
          current.v = this.m_CurrentLM;
          if (this.m_CurrentLM !== null && this.m_CurrentLM.Y === Y) {
            this.m_CurrentLM = this.m_CurrentLM.Next;
            return true;
          }
          return false;
        };
        ClipperLib2.ClipperBase.prototype.ReverseHorizontal = function(e) {
          var tmp = e.Top.X;
          e.Top.X = e.Bot.X;
          e.Bot.X = tmp;
          if (ClipperLib2.use_xyz) {
            tmp = e.Top.Z;
            e.Top.Z = e.Bot.Z;
            e.Bot.Z = tmp;
          }
        };
        ClipperLib2.ClipperBase.prototype.Reset = function() {
          this.m_CurrentLM = this.m_MinimaList;
          if (this.m_CurrentLM === null)
            return;
          this.m_Scanbeam = null;
          var lm = this.m_MinimaList;
          while (lm !== null) {
            this.InsertScanbeam(lm.Y);
            var e = lm.LeftBound;
            if (e !== null) {
              e.Curr.X = e.Bot.X;
              e.Curr.Y = e.Bot.Y;
              if (ClipperLib2.use_xyz) e.Curr.Z = e.Bot.Z;
              e.OutIdx = ClipperLib2.ClipperBase.Unassigned;
            }
            e = lm.RightBound;
            if (e !== null) {
              e.Curr.X = e.Bot.X;
              e.Curr.Y = e.Bot.Y;
              if (ClipperLib2.use_xyz) e.Curr.Z = e.Bot.Z;
              e.OutIdx = ClipperLib2.ClipperBase.Unassigned;
            }
            lm = lm.Next;
          }
          this.m_ActiveEdges = null;
        };
        ClipperLib2.ClipperBase.prototype.InsertScanbeam = function(Y) {
          if (this.m_Scanbeam === null) {
            this.m_Scanbeam = new ClipperLib2.Scanbeam();
            this.m_Scanbeam.Next = null;
            this.m_Scanbeam.Y = Y;
          } else if (Y > this.m_Scanbeam.Y) {
            var newSb = new ClipperLib2.Scanbeam();
            newSb.Y = Y;
            newSb.Next = this.m_Scanbeam;
            this.m_Scanbeam = newSb;
          } else {
            var sb2 = this.m_Scanbeam;
            while (sb2.Next !== null && Y <= sb2.Next.Y) {
              sb2 = sb2.Next;
            }
            if (Y === sb2.Y) {
              return;
            }
            var newSb1 = new ClipperLib2.Scanbeam();
            newSb1.Y = Y;
            newSb1.Next = sb2.Next;
            sb2.Next = newSb1;
          }
        };
        ClipperLib2.ClipperBase.prototype.PopScanbeam = function(Y) {
          if (this.m_Scanbeam === null) {
            Y.v = 0;
            return false;
          }
          Y.v = this.m_Scanbeam.Y;
          this.m_Scanbeam = this.m_Scanbeam.Next;
          return true;
        };
        ClipperLib2.ClipperBase.prototype.LocalMinimaPending = function() {
          return this.m_CurrentLM !== null;
        };
        ClipperLib2.ClipperBase.prototype.CreateOutRec = function() {
          var result = new ClipperLib2.OutRec();
          result.Idx = ClipperLib2.ClipperBase.Unassigned;
          result.IsHole = false;
          result.IsOpen = false;
          result.FirstLeft = null;
          result.Pts = null;
          result.BottomPt = null;
          result.PolyNode = null;
          this.m_PolyOuts.push(result);
          result.Idx = this.m_PolyOuts.length - 1;
          return result;
        };
        ClipperLib2.ClipperBase.prototype.DisposeOutRec = function(index) {
          var outRec = this.m_PolyOuts[index];
          outRec.Pts = null;
          outRec = null;
          this.m_PolyOuts[index] = null;
        };
        ClipperLib2.ClipperBase.prototype.UpdateEdgeIntoAEL = function(e) {
          if (e.NextInLML === null) {
            ClipperLib2.Error("UpdateEdgeIntoAEL: invalid call");
          }
          var AelPrev = e.PrevInAEL;
          var AelNext = e.NextInAEL;
          e.NextInLML.OutIdx = e.OutIdx;
          if (AelPrev !== null) {
            AelPrev.NextInAEL = e.NextInLML;
          } else {
            this.m_ActiveEdges = e.NextInLML;
          }
          if (AelNext !== null) {
            AelNext.PrevInAEL = e.NextInLML;
          }
          e.NextInLML.Side = e.Side;
          e.NextInLML.WindDelta = e.WindDelta;
          e.NextInLML.WindCnt = e.WindCnt;
          e.NextInLML.WindCnt2 = e.WindCnt2;
          e = e.NextInLML;
          e.Curr.X = e.Bot.X;
          e.Curr.Y = e.Bot.Y;
          e.PrevInAEL = AelPrev;
          e.NextInAEL = AelNext;
          if (!ClipperLib2.ClipperBase.IsHorizontal(e)) {
            this.InsertScanbeam(e.Top.Y);
          }
          return e;
        };
        ClipperLib2.ClipperBase.prototype.SwapPositionsInAEL = function(edge1, edge2) {
          if (edge1.NextInAEL === edge1.PrevInAEL || edge2.NextInAEL === edge2.PrevInAEL) {
            return;
          }
          if (edge1.NextInAEL === edge2) {
            var next = edge2.NextInAEL;
            if (next !== null) {
              next.PrevInAEL = edge1;
            }
            var prev = edge1.PrevInAEL;
            if (prev !== null) {
              prev.NextInAEL = edge2;
            }
            edge2.PrevInAEL = prev;
            edge2.NextInAEL = edge1;
            edge1.PrevInAEL = edge2;
            edge1.NextInAEL = next;
          } else if (edge2.NextInAEL === edge1) {
            var next1 = edge1.NextInAEL;
            if (next1 !== null) {
              next1.PrevInAEL = edge2;
            }
            var prev1 = edge2.PrevInAEL;
            if (prev1 !== null) {
              prev1.NextInAEL = edge1;
            }
            edge1.PrevInAEL = prev1;
            edge1.NextInAEL = edge2;
            edge2.PrevInAEL = edge1;
            edge2.NextInAEL = next1;
          } else {
            var next2 = edge1.NextInAEL;
            var prev2 = edge1.PrevInAEL;
            edge1.NextInAEL = edge2.NextInAEL;
            if (edge1.NextInAEL !== null) {
              edge1.NextInAEL.PrevInAEL = edge1;
            }
            edge1.PrevInAEL = edge2.PrevInAEL;
            if (edge1.PrevInAEL !== null) {
              edge1.PrevInAEL.NextInAEL = edge1;
            }
            edge2.NextInAEL = next2;
            if (edge2.NextInAEL !== null) {
              edge2.NextInAEL.PrevInAEL = edge2;
            }
            edge2.PrevInAEL = prev2;
            if (edge2.PrevInAEL !== null) {
              edge2.PrevInAEL.NextInAEL = edge2;
            }
          }
          if (edge1.PrevInAEL === null) {
            this.m_ActiveEdges = edge1;
          } else {
            if (edge2.PrevInAEL === null) {
              this.m_ActiveEdges = edge2;
            }
          }
        };
        ClipperLib2.ClipperBase.prototype.DeleteFromAEL = function(e) {
          var AelPrev = e.PrevInAEL;
          var AelNext = e.NextInAEL;
          if (AelPrev === null && AelNext === null && e !== this.m_ActiveEdges) {
            return;
          }
          if (AelPrev !== null) {
            AelPrev.NextInAEL = AelNext;
          } else {
            this.m_ActiveEdges = AelNext;
          }
          if (AelNext !== null) {
            AelNext.PrevInAEL = AelPrev;
          }
          e.NextInAEL = null;
          e.PrevInAEL = null;
        };
        ClipperLib2.Clipper = function(InitOptions) {
          if (typeof InitOptions === "undefined") InitOptions = 0;
          this.m_PolyOuts = null;
          this.m_ClipType = ClipperLib2.ClipType.ctIntersection;
          this.m_Scanbeam = null;
          this.m_Maxima = null;
          this.m_ActiveEdges = null;
          this.m_SortedEdges = null;
          this.m_IntersectList = null;
          this.m_IntersectNodeComparer = null;
          this.m_ExecuteLocked = false;
          this.m_ClipFillType = ClipperLib2.PolyFillType.pftEvenOdd;
          this.m_SubjFillType = ClipperLib2.PolyFillType.pftEvenOdd;
          this.m_Joins = null;
          this.m_GhostJoins = null;
          this.m_UsingPolyTree = false;
          this.ReverseSolution = false;
          this.StrictlySimple = false;
          ClipperLib2.ClipperBase.call(this);
          this.m_Scanbeam = null;
          this.m_Maxima = null;
          this.m_ActiveEdges = null;
          this.m_SortedEdges = null;
          this.m_IntersectList = new Array();
          this.m_IntersectNodeComparer = ClipperLib2.MyIntersectNodeSort.Compare;
          this.m_ExecuteLocked = false;
          this.m_UsingPolyTree = false;
          this.m_PolyOuts = new Array();
          this.m_Joins = new Array();
          this.m_GhostJoins = new Array();
          this.ReverseSolution = (1 & InitOptions) !== 0;
          this.StrictlySimple = (2 & InitOptions) !== 0;
          this.PreserveCollinear = (4 & InitOptions) !== 0;
          if (ClipperLib2.use_xyz) {
            this.ZFillFunction = null;
          }
        };
        ClipperLib2.Clipper.ioReverseSolution = 1;
        ClipperLib2.Clipper.ioStrictlySimple = 2;
        ClipperLib2.Clipper.ioPreserveCollinear = 4;
        ClipperLib2.Clipper.prototype.Clear = function() {
          if (this.m_edges.length === 0)
            return;
          this.DisposeAllPolyPts();
          ClipperLib2.ClipperBase.prototype.Clear.call(this);
        };
        ClipperLib2.Clipper.prototype.InsertMaxima = function(X) {
          var newMax = new ClipperLib2.Maxima();
          newMax.X = X;
          if (this.m_Maxima === null) {
            this.m_Maxima = newMax;
            this.m_Maxima.Next = null;
            this.m_Maxima.Prev = null;
          } else if (X < this.m_Maxima.X) {
            newMax.Next = this.m_Maxima;
            newMax.Prev = null;
            this.m_Maxima = newMax;
          } else {
            var m = this.m_Maxima;
            while (m.Next !== null && X >= m.Next.X) {
              m = m.Next;
            }
            if (X === m.X) {
              return;
            }
            newMax.Next = m.Next;
            newMax.Prev = m;
            if (m.Next !== null) {
              m.Next.Prev = newMax;
            }
            m.Next = newMax;
          }
        };
        ClipperLib2.Clipper.prototype.Execute = function() {
          var a = arguments, alen = a.length, ispolytree = a[1] instanceof ClipperLib2.PolyTree;
          if (alen === 4 && !ispolytree) {
            var clipType = a[0], solution = a[1], subjFillType = a[2], clipFillType = a[3];
            if (this.m_ExecuteLocked)
              return false;
            if (this.m_HasOpenPaths)
              ClipperLib2.Error("Error: PolyTree struct is needed for open path clipping.");
            this.m_ExecuteLocked = true;
            ClipperLib2.Clear(solution);
            this.m_SubjFillType = subjFillType;
            this.m_ClipFillType = clipFillType;
            this.m_ClipType = clipType;
            this.m_UsingPolyTree = false;
            try {
              var succeeded = this.ExecuteInternal();
              if (succeeded) this.BuildResult(solution);
            } finally {
              this.DisposeAllPolyPts();
              this.m_ExecuteLocked = false;
            }
            return succeeded;
          } else if (alen === 4 && ispolytree) {
            var clipType = a[0], polytree = a[1], subjFillType = a[2], clipFillType = a[3];
            if (this.m_ExecuteLocked)
              return false;
            this.m_ExecuteLocked = true;
            this.m_SubjFillType = subjFillType;
            this.m_ClipFillType = clipFillType;
            this.m_ClipType = clipType;
            this.m_UsingPolyTree = true;
            try {
              var succeeded = this.ExecuteInternal();
              if (succeeded) this.BuildResult2(polytree);
            } finally {
              this.DisposeAllPolyPts();
              this.m_ExecuteLocked = false;
            }
            return succeeded;
          } else if (alen === 2 && !ispolytree) {
            var clipType = a[0], solution = a[1];
            return this.Execute(clipType, solution, ClipperLib2.PolyFillType.pftEvenOdd, ClipperLib2.PolyFillType.pftEvenOdd);
          } else if (alen === 2 && ispolytree) {
            var clipType = a[0], polytree = a[1];
            return this.Execute(clipType, polytree, ClipperLib2.PolyFillType.pftEvenOdd, ClipperLib2.PolyFillType.pftEvenOdd);
          }
        };
        ClipperLib2.Clipper.prototype.FixHoleLinkage = function(outRec) {
          if (outRec.FirstLeft === null || outRec.IsHole !== outRec.FirstLeft.IsHole && outRec.FirstLeft.Pts !== null)
            return;
          var orfl = outRec.FirstLeft;
          while (orfl !== null && (orfl.IsHole === outRec.IsHole || orfl.Pts === null))
            orfl = orfl.FirstLeft;
          outRec.FirstLeft = orfl;
        };
        ClipperLib2.Clipper.prototype.ExecuteInternal = function() {
          try {
            this.Reset();
            this.m_SortedEdges = null;
            this.m_Maxima = null;
            var botY = {}, topY = {};
            if (!this.PopScanbeam(botY)) {
              return false;
            }
            this.InsertLocalMinimaIntoAEL(botY.v);
            while (this.PopScanbeam(topY) || this.LocalMinimaPending()) {
              this.ProcessHorizontals();
              this.m_GhostJoins.length = 0;
              if (!this.ProcessIntersections(topY.v)) {
                return false;
              }
              this.ProcessEdgesAtTopOfScanbeam(topY.v);
              botY.v = topY.v;
              this.InsertLocalMinimaIntoAEL(botY.v);
            }
            var outRec, i, ilen;
            for (i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
              outRec = this.m_PolyOuts[i];
              if (outRec.Pts === null || outRec.IsOpen) continue;
              if ((outRec.IsHole ^ this.ReverseSolution) == this.Area$1(outRec) > 0)
                this.ReversePolyPtLinks(outRec.Pts);
            }
            this.JoinCommonEdges();
            for (i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
              outRec = this.m_PolyOuts[i];
              if (outRec.Pts === null)
                continue;
              else if (outRec.IsOpen)
                this.FixupOutPolyline(outRec);
              else
                this.FixupOutPolygon(outRec);
            }
            if (this.StrictlySimple) this.DoSimplePolygons();
            return true;
          } finally {
            this.m_Joins.length = 0;
            this.m_GhostJoins.length = 0;
          }
        };
        ClipperLib2.Clipper.prototype.DisposeAllPolyPts = function() {
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; ++i)
            this.DisposeOutRec(i);
          ClipperLib2.Clear(this.m_PolyOuts);
        };
        ClipperLib2.Clipper.prototype.AddJoin = function(Op1, Op2, OffPt) {
          var j = new ClipperLib2.Join();
          j.OutPt1 = Op1;
          j.OutPt2 = Op2;
          j.OffPt.X = OffPt.X;
          j.OffPt.Y = OffPt.Y;
          if (ClipperLib2.use_xyz) j.OffPt.Z = OffPt.Z;
          this.m_Joins.push(j);
        };
        ClipperLib2.Clipper.prototype.AddGhostJoin = function(Op, OffPt) {
          var j = new ClipperLib2.Join();
          j.OutPt1 = Op;
          j.OffPt.X = OffPt.X;
          j.OffPt.Y = OffPt.Y;
          if (ClipperLib2.use_xyz) j.OffPt.Z = OffPt.Z;
          this.m_GhostJoins.push(j);
        };
        ClipperLib2.Clipper.prototype.SetZ = function(pt, e1, e2) {
          if (this.ZFillFunction !== null) {
            if (pt.Z !== 0 || this.ZFillFunction === null) return;
            else if (ClipperLib2.IntPoint.op_Equality(pt, e1.Bot)) pt.Z = e1.Bot.Z;
            else if (ClipperLib2.IntPoint.op_Equality(pt, e1.Top)) pt.Z = e1.Top.Z;
            else if (ClipperLib2.IntPoint.op_Equality(pt, e2.Bot)) pt.Z = e2.Bot.Z;
            else if (ClipperLib2.IntPoint.op_Equality(pt, e2.Top)) pt.Z = e2.Top.Z;
            else this.ZFillFunction(e1.Bot, e1.Top, e2.Bot, e2.Top, pt);
          }
        };
        ClipperLib2.Clipper.prototype.InsertLocalMinimaIntoAEL = function(botY) {
          var lm = {};
          var lb;
          var rb;
          while (this.PopLocalMinima(botY, lm)) {
            lb = lm.v.LeftBound;
            rb = lm.v.RightBound;
            var Op1 = null;
            if (lb === null) {
              this.InsertEdgeIntoAEL(rb, null);
              this.SetWindingCount(rb);
              if (this.IsContributing(rb))
                Op1 = this.AddOutPt(rb, rb.Bot);
            } else if (rb === null) {
              this.InsertEdgeIntoAEL(lb, null);
              this.SetWindingCount(lb);
              if (this.IsContributing(lb))
                Op1 = this.AddOutPt(lb, lb.Bot);
              this.InsertScanbeam(lb.Top.Y);
            } else {
              this.InsertEdgeIntoAEL(lb, null);
              this.InsertEdgeIntoAEL(rb, lb);
              this.SetWindingCount(lb);
              rb.WindCnt = lb.WindCnt;
              rb.WindCnt2 = lb.WindCnt2;
              if (this.IsContributing(lb))
                Op1 = this.AddLocalMinPoly(lb, rb, lb.Bot);
              this.InsertScanbeam(lb.Top.Y);
            }
            if (rb !== null) {
              if (ClipperLib2.ClipperBase.IsHorizontal(rb)) {
                if (rb.NextInLML !== null) {
                  this.InsertScanbeam(rb.NextInLML.Top.Y);
                }
                this.AddEdgeToSEL(rb);
              } else {
                this.InsertScanbeam(rb.Top.Y);
              }
            }
            if (lb === null || rb === null) continue;
            if (Op1 !== null && ClipperLib2.ClipperBase.IsHorizontal(rb) && this.m_GhostJoins.length > 0 && rb.WindDelta !== 0) {
              for (var i = 0, ilen = this.m_GhostJoins.length; i < ilen; i++) {
                var j = this.m_GhostJoins[i];
                if (this.HorzSegmentsOverlap(j.OutPt1.Pt.X, j.OffPt.X, rb.Bot.X, rb.Top.X))
                  this.AddJoin(j.OutPt1, Op1, j.OffPt);
              }
            }
            if (lb.OutIdx >= 0 && lb.PrevInAEL !== null && lb.PrevInAEL.Curr.X === lb.Bot.X && lb.PrevInAEL.OutIdx >= 0 && ClipperLib2.ClipperBase.SlopesEqual5(lb.PrevInAEL.Curr, lb.PrevInAEL.Top, lb.Curr, lb.Top, this.m_UseFullRange) && lb.WindDelta !== 0 && lb.PrevInAEL.WindDelta !== 0) {
              var Op2 = this.AddOutPt(lb.PrevInAEL, lb.Bot);
              this.AddJoin(Op1, Op2, lb.Top);
            }
            if (lb.NextInAEL !== rb) {
              if (rb.OutIdx >= 0 && rb.PrevInAEL.OutIdx >= 0 && ClipperLib2.ClipperBase.SlopesEqual5(rb.PrevInAEL.Curr, rb.PrevInAEL.Top, rb.Curr, rb.Top, this.m_UseFullRange) && rb.WindDelta !== 0 && rb.PrevInAEL.WindDelta !== 0) {
                var Op2 = this.AddOutPt(rb.PrevInAEL, rb.Bot);
                this.AddJoin(Op1, Op2, rb.Top);
              }
              var e = lb.NextInAEL;
              if (e !== null)
                while (e !== rb) {
                  this.IntersectEdges(rb, e, lb.Curr);
                  e = e.NextInAEL;
                }
            }
          }
        };
        ClipperLib2.Clipper.prototype.InsertEdgeIntoAEL = function(edge, startEdge) {
          if (this.m_ActiveEdges === null) {
            edge.PrevInAEL = null;
            edge.NextInAEL = null;
            this.m_ActiveEdges = edge;
          } else if (startEdge === null && this.E2InsertsBeforeE1(this.m_ActiveEdges, edge)) {
            edge.PrevInAEL = null;
            edge.NextInAEL = this.m_ActiveEdges;
            this.m_ActiveEdges.PrevInAEL = edge;
            this.m_ActiveEdges = edge;
          } else {
            if (startEdge === null)
              startEdge = this.m_ActiveEdges;
            while (startEdge.NextInAEL !== null && !this.E2InsertsBeforeE1(startEdge.NextInAEL, edge))
              startEdge = startEdge.NextInAEL;
            edge.NextInAEL = startEdge.NextInAEL;
            if (startEdge.NextInAEL !== null)
              startEdge.NextInAEL.PrevInAEL = edge;
            edge.PrevInAEL = startEdge;
            startEdge.NextInAEL = edge;
          }
        };
        ClipperLib2.Clipper.prototype.E2InsertsBeforeE1 = function(e1, e2) {
          if (e2.Curr.X === e1.Curr.X) {
            if (e2.Top.Y > e1.Top.Y)
              return e2.Top.X < ClipperLib2.Clipper.TopX(e1, e2.Top.Y);
            else
              return e1.Top.X > ClipperLib2.Clipper.TopX(e2, e1.Top.Y);
          } else
            return e2.Curr.X < e1.Curr.X;
        };
        ClipperLib2.Clipper.prototype.IsEvenOddFillType = function(edge) {
          if (edge.PolyTyp === ClipperLib2.PolyType.ptSubject)
            return this.m_SubjFillType === ClipperLib2.PolyFillType.pftEvenOdd;
          else
            return this.m_ClipFillType === ClipperLib2.PolyFillType.pftEvenOdd;
        };
        ClipperLib2.Clipper.prototype.IsEvenOddAltFillType = function(edge) {
          if (edge.PolyTyp === ClipperLib2.PolyType.ptSubject)
            return this.m_ClipFillType === ClipperLib2.PolyFillType.pftEvenOdd;
          else
            return this.m_SubjFillType === ClipperLib2.PolyFillType.pftEvenOdd;
        };
        ClipperLib2.Clipper.prototype.IsContributing = function(edge) {
          var pft, pft2;
          if (edge.PolyTyp === ClipperLib2.PolyType.ptSubject) {
            pft = this.m_SubjFillType;
            pft2 = this.m_ClipFillType;
          } else {
            pft = this.m_ClipFillType;
            pft2 = this.m_SubjFillType;
          }
          switch (pft) {
            case ClipperLib2.PolyFillType.pftEvenOdd:
              if (edge.WindDelta === 0 && edge.WindCnt !== 1)
                return false;
              break;
            case ClipperLib2.PolyFillType.pftNonZero:
              if (Math.abs(edge.WindCnt) !== 1)
                return false;
              break;
            case ClipperLib2.PolyFillType.pftPositive:
              if (edge.WindCnt !== 1)
                return false;
              break;
            default:
              if (edge.WindCnt !== -1)
                return false;
              break;
          }
          switch (this.m_ClipType) {
            case ClipperLib2.ClipType.ctIntersection:
              switch (pft2) {
                case ClipperLib2.PolyFillType.pftEvenOdd:
                case ClipperLib2.PolyFillType.pftNonZero:
                  return edge.WindCnt2 !== 0;
                case ClipperLib2.PolyFillType.pftPositive:
                  return edge.WindCnt2 > 0;
                default:
                  return edge.WindCnt2 < 0;
              }
            case ClipperLib2.ClipType.ctUnion:
              switch (pft2) {
                case ClipperLib2.PolyFillType.pftEvenOdd:
                case ClipperLib2.PolyFillType.pftNonZero:
                  return edge.WindCnt2 === 0;
                case ClipperLib2.PolyFillType.pftPositive:
                  return edge.WindCnt2 <= 0;
                default:
                  return edge.WindCnt2 >= 0;
              }
            case ClipperLib2.ClipType.ctDifference:
              if (edge.PolyTyp === ClipperLib2.PolyType.ptSubject)
                switch (pft2) {
                  case ClipperLib2.PolyFillType.pftEvenOdd:
                  case ClipperLib2.PolyFillType.pftNonZero:
                    return edge.WindCnt2 === 0;
                  case ClipperLib2.PolyFillType.pftPositive:
                    return edge.WindCnt2 <= 0;
                  default:
                    return edge.WindCnt2 >= 0;
                }
              else
                switch (pft2) {
                  case ClipperLib2.PolyFillType.pftEvenOdd:
                  case ClipperLib2.PolyFillType.pftNonZero:
                    return edge.WindCnt2 !== 0;
                  case ClipperLib2.PolyFillType.pftPositive:
                    return edge.WindCnt2 > 0;
                  default:
                    return edge.WindCnt2 < 0;
                }
            case ClipperLib2.ClipType.ctXor:
              if (edge.WindDelta === 0)
                switch (pft2) {
                  case ClipperLib2.PolyFillType.pftEvenOdd:
                  case ClipperLib2.PolyFillType.pftNonZero:
                    return edge.WindCnt2 === 0;
                  case ClipperLib2.PolyFillType.pftPositive:
                    return edge.WindCnt2 <= 0;
                  default:
                    return edge.WindCnt2 >= 0;
                }
              else
                return true;
          }
          return true;
        };
        ClipperLib2.Clipper.prototype.SetWindingCount = function(edge) {
          var e = edge.PrevInAEL;
          while (e !== null && (e.PolyTyp !== edge.PolyTyp || e.WindDelta === 0))
            e = e.PrevInAEL;
          if (e === null) {
            var pft = edge.PolyTyp === ClipperLib2.PolyType.ptSubject ? this.m_SubjFillType : this.m_ClipFillType;
            if (edge.WindDelta === 0) {
              edge.WindCnt = pft === ClipperLib2.PolyFillType.pftNegative ? -1 : 1;
            } else {
              edge.WindCnt = edge.WindDelta;
            }
            edge.WindCnt2 = 0;
            e = this.m_ActiveEdges;
          } else if (edge.WindDelta === 0 && this.m_ClipType !== ClipperLib2.ClipType.ctUnion) {
            edge.WindCnt = 1;
            edge.WindCnt2 = e.WindCnt2;
            e = e.NextInAEL;
          } else if (this.IsEvenOddFillType(edge)) {
            if (edge.WindDelta === 0) {
              var Inside = true;
              var e2 = e.PrevInAEL;
              while (e2 !== null) {
                if (e2.PolyTyp === e.PolyTyp && e2.WindDelta !== 0)
                  Inside = !Inside;
                e2 = e2.PrevInAEL;
              }
              edge.WindCnt = Inside ? 0 : 1;
            } else {
              edge.WindCnt = edge.WindDelta;
            }
            edge.WindCnt2 = e.WindCnt2;
            e = e.NextInAEL;
          } else {
            if (e.WindCnt * e.WindDelta < 0) {
              if (Math.abs(e.WindCnt) > 1) {
                if (e.WindDelta * edge.WindDelta < 0)
                  edge.WindCnt = e.WindCnt;
                else
                  edge.WindCnt = e.WindCnt + edge.WindDelta;
              } else
                edge.WindCnt = edge.WindDelta === 0 ? 1 : edge.WindDelta;
            } else {
              if (edge.WindDelta === 0)
                edge.WindCnt = e.WindCnt < 0 ? e.WindCnt - 1 : e.WindCnt + 1;
              else if (e.WindDelta * edge.WindDelta < 0)
                edge.WindCnt = e.WindCnt;
              else
                edge.WindCnt = e.WindCnt + edge.WindDelta;
            }
            edge.WindCnt2 = e.WindCnt2;
            e = e.NextInAEL;
          }
          if (this.IsEvenOddAltFillType(edge)) {
            while (e !== edge) {
              if (e.WindDelta !== 0)
                edge.WindCnt2 = edge.WindCnt2 === 0 ? 1 : 0;
              e = e.NextInAEL;
            }
          } else {
            while (e !== edge) {
              edge.WindCnt2 += e.WindDelta;
              e = e.NextInAEL;
            }
          }
        };
        ClipperLib2.Clipper.prototype.AddEdgeToSEL = function(edge) {
          if (this.m_SortedEdges === null) {
            this.m_SortedEdges = edge;
            edge.PrevInSEL = null;
            edge.NextInSEL = null;
          } else {
            edge.NextInSEL = this.m_SortedEdges;
            edge.PrevInSEL = null;
            this.m_SortedEdges.PrevInSEL = edge;
            this.m_SortedEdges = edge;
          }
        };
        ClipperLib2.Clipper.prototype.PopEdgeFromSEL = function(e) {
          e.v = this.m_SortedEdges;
          if (e.v === null) {
            return false;
          }
          var oldE = e.v;
          this.m_SortedEdges = e.v.NextInSEL;
          if (this.m_SortedEdges !== null) {
            this.m_SortedEdges.PrevInSEL = null;
          }
          oldE.NextInSEL = null;
          oldE.PrevInSEL = null;
          return true;
        };
        ClipperLib2.Clipper.prototype.CopyAELToSEL = function() {
          var e = this.m_ActiveEdges;
          this.m_SortedEdges = e;
          while (e !== null) {
            e.PrevInSEL = e.PrevInAEL;
            e.NextInSEL = e.NextInAEL;
            e = e.NextInAEL;
          }
        };
        ClipperLib2.Clipper.prototype.SwapPositionsInSEL = function(edge1, edge2) {
          if (edge1.NextInSEL === null && edge1.PrevInSEL === null)
            return;
          if (edge2.NextInSEL === null && edge2.PrevInSEL === null)
            return;
          if (edge1.NextInSEL === edge2) {
            var next = edge2.NextInSEL;
            if (next !== null)
              next.PrevInSEL = edge1;
            var prev = edge1.PrevInSEL;
            if (prev !== null)
              prev.NextInSEL = edge2;
            edge2.PrevInSEL = prev;
            edge2.NextInSEL = edge1;
            edge1.PrevInSEL = edge2;
            edge1.NextInSEL = next;
          } else if (edge2.NextInSEL === edge1) {
            var next = edge1.NextInSEL;
            if (next !== null)
              next.PrevInSEL = edge2;
            var prev = edge2.PrevInSEL;
            if (prev !== null)
              prev.NextInSEL = edge1;
            edge1.PrevInSEL = prev;
            edge1.NextInSEL = edge2;
            edge2.PrevInSEL = edge1;
            edge2.NextInSEL = next;
          } else {
            var next = edge1.NextInSEL;
            var prev = edge1.PrevInSEL;
            edge1.NextInSEL = edge2.NextInSEL;
            if (edge1.NextInSEL !== null)
              edge1.NextInSEL.PrevInSEL = edge1;
            edge1.PrevInSEL = edge2.PrevInSEL;
            if (edge1.PrevInSEL !== null)
              edge1.PrevInSEL.NextInSEL = edge1;
            edge2.NextInSEL = next;
            if (edge2.NextInSEL !== null)
              edge2.NextInSEL.PrevInSEL = edge2;
            edge2.PrevInSEL = prev;
            if (edge2.PrevInSEL !== null)
              edge2.PrevInSEL.NextInSEL = edge2;
          }
          if (edge1.PrevInSEL === null)
            this.m_SortedEdges = edge1;
          else if (edge2.PrevInSEL === null)
            this.m_SortedEdges = edge2;
        };
        ClipperLib2.Clipper.prototype.AddLocalMaxPoly = function(e1, e2, pt) {
          this.AddOutPt(e1, pt);
          if (e2.WindDelta === 0) this.AddOutPt(e2, pt);
          if (e1.OutIdx === e2.OutIdx) {
            e1.OutIdx = -1;
            e2.OutIdx = -1;
          } else if (e1.OutIdx < e2.OutIdx)
            this.AppendPolygon(e1, e2);
          else
            this.AppendPolygon(e2, e1);
        };
        ClipperLib2.Clipper.prototype.AddLocalMinPoly = function(e1, e2, pt) {
          var result;
          var e, prevE;
          if (ClipperLib2.ClipperBase.IsHorizontal(e2) || e1.Dx > e2.Dx) {
            result = this.AddOutPt(e1, pt);
            e2.OutIdx = e1.OutIdx;
            e1.Side = ClipperLib2.EdgeSide.esLeft;
            e2.Side = ClipperLib2.EdgeSide.esRight;
            e = e1;
            if (e.PrevInAEL === e2)
              prevE = e2.PrevInAEL;
            else
              prevE = e.PrevInAEL;
          } else {
            result = this.AddOutPt(e2, pt);
            e1.OutIdx = e2.OutIdx;
            e1.Side = ClipperLib2.EdgeSide.esRight;
            e2.Side = ClipperLib2.EdgeSide.esLeft;
            e = e2;
            if (e.PrevInAEL === e1)
              prevE = e1.PrevInAEL;
            else
              prevE = e.PrevInAEL;
          }
          if (prevE !== null && prevE.OutIdx >= 0 && prevE.Top.Y < pt.Y && e.Top.Y < pt.Y) {
            var xPrev = ClipperLib2.Clipper.TopX(prevE, pt.Y);
            var xE = ClipperLib2.Clipper.TopX(e, pt.Y);
            if (xPrev === xE && e.WindDelta !== 0 && prevE.WindDelta !== 0 && ClipperLib2.ClipperBase.SlopesEqual5(new ClipperLib2.IntPoint2(xPrev, pt.Y), prevE.Top, new ClipperLib2.IntPoint2(xE, pt.Y), e.Top, this.m_UseFullRange)) {
              var outPt = this.AddOutPt(prevE, pt);
              this.AddJoin(result, outPt, e.Top);
            }
          }
          return result;
        };
        ClipperLib2.Clipper.prototype.AddOutPt = function(e, pt) {
          if (e.OutIdx < 0) {
            var outRec = this.CreateOutRec();
            outRec.IsOpen = e.WindDelta === 0;
            var newOp = new ClipperLib2.OutPt();
            outRec.Pts = newOp;
            newOp.Idx = outRec.Idx;
            newOp.Pt.X = pt.X;
            newOp.Pt.Y = pt.Y;
            if (ClipperLib2.use_xyz) newOp.Pt.Z = pt.Z;
            newOp.Next = newOp;
            newOp.Prev = newOp;
            if (!outRec.IsOpen)
              this.SetHoleState(e, outRec);
            e.OutIdx = outRec.Idx;
            return newOp;
          } else {
            var outRec = this.m_PolyOuts[e.OutIdx];
            var op = outRec.Pts;
            var ToFront = e.Side === ClipperLib2.EdgeSide.esLeft;
            if (ToFront && ClipperLib2.IntPoint.op_Equality(pt, op.Pt))
              return op;
            else if (!ToFront && ClipperLib2.IntPoint.op_Equality(pt, op.Prev.Pt))
              return op.Prev;
            var newOp = new ClipperLib2.OutPt();
            newOp.Idx = outRec.Idx;
            newOp.Pt.X = pt.X;
            newOp.Pt.Y = pt.Y;
            if (ClipperLib2.use_xyz) newOp.Pt.Z = pt.Z;
            newOp.Next = op;
            newOp.Prev = op.Prev;
            newOp.Prev.Next = newOp;
            op.Prev = newOp;
            if (ToFront)
              outRec.Pts = newOp;
            return newOp;
          }
        };
        ClipperLib2.Clipper.prototype.GetLastOutPt = function(e) {
          var outRec = this.m_PolyOuts[e.OutIdx];
          if (e.Side === ClipperLib2.EdgeSide.esLeft) {
            return outRec.Pts;
          } else {
            return outRec.Pts.Prev;
          }
        };
        ClipperLib2.Clipper.prototype.SwapPoints = function(pt1, pt2) {
          var tmp = new ClipperLib2.IntPoint1(pt1.Value);
          pt1.Value.X = pt2.Value.X;
          pt1.Value.Y = pt2.Value.Y;
          if (ClipperLib2.use_xyz) pt1.Value.Z = pt2.Value.Z;
          pt2.Value.X = tmp.X;
          pt2.Value.Y = tmp.Y;
          if (ClipperLib2.use_xyz) pt2.Value.Z = tmp.Z;
        };
        ClipperLib2.Clipper.prototype.HorzSegmentsOverlap = function(seg1a, seg1b, seg2a, seg2b) {
          var tmp;
          if (seg1a > seg1b) {
            tmp = seg1a;
            seg1a = seg1b;
            seg1b = tmp;
          }
          if (seg2a > seg2b) {
            tmp = seg2a;
            seg2a = seg2b;
            seg2b = tmp;
          }
          return seg1a < seg2b && seg2a < seg1b;
        };
        ClipperLib2.Clipper.prototype.SetHoleState = function(e, outRec) {
          var e2 = e.PrevInAEL;
          var eTmp = null;
          while (e2 !== null) {
            if (e2.OutIdx >= 0 && e2.WindDelta !== 0) {
              if (eTmp === null)
                eTmp = e2;
              else if (eTmp.OutIdx === e2.OutIdx)
                eTmp = null;
            }
            e2 = e2.PrevInAEL;
          }
          if (eTmp === null) {
            outRec.FirstLeft = null;
            outRec.IsHole = false;
          } else {
            outRec.FirstLeft = this.m_PolyOuts[eTmp.OutIdx];
            outRec.IsHole = !outRec.FirstLeft.IsHole;
          }
        };
        ClipperLib2.Clipper.prototype.GetDx = function(pt1, pt2) {
          if (pt1.Y === pt2.Y)
            return ClipperLib2.ClipperBase.horizontal;
          else
            return (pt2.X - pt1.X) / (pt2.Y - pt1.Y);
        };
        ClipperLib2.Clipper.prototype.FirstIsBottomPt = function(btmPt1, btmPt2) {
          var p = btmPt1.Prev;
          while (ClipperLib2.IntPoint.op_Equality(p.Pt, btmPt1.Pt) && p !== btmPt1)
            p = p.Prev;
          var dx1p = Math.abs(this.GetDx(btmPt1.Pt, p.Pt));
          p = btmPt1.Next;
          while (ClipperLib2.IntPoint.op_Equality(p.Pt, btmPt1.Pt) && p !== btmPt1)
            p = p.Next;
          var dx1n = Math.abs(this.GetDx(btmPt1.Pt, p.Pt));
          p = btmPt2.Prev;
          while (ClipperLib2.IntPoint.op_Equality(p.Pt, btmPt2.Pt) && p !== btmPt2)
            p = p.Prev;
          var dx2p = Math.abs(this.GetDx(btmPt2.Pt, p.Pt));
          p = btmPt2.Next;
          while (ClipperLib2.IntPoint.op_Equality(p.Pt, btmPt2.Pt) && p !== btmPt2)
            p = p.Next;
          var dx2n = Math.abs(this.GetDx(btmPt2.Pt, p.Pt));
          if (Math.max(dx1p, dx1n) === Math.max(dx2p, dx2n) && Math.min(dx1p, dx1n) === Math.min(dx2p, dx2n)) {
            return this.Area(btmPt1) > 0;
          } else {
            return dx1p >= dx2p && dx1p >= dx2n || dx1n >= dx2p && dx1n >= dx2n;
          }
        };
        ClipperLib2.Clipper.prototype.GetBottomPt = function(pp) {
          var dups = null;
          var p = pp.Next;
          while (p !== pp) {
            if (p.Pt.Y > pp.Pt.Y) {
              pp = p;
              dups = null;
            } else if (p.Pt.Y === pp.Pt.Y && p.Pt.X <= pp.Pt.X) {
              if (p.Pt.X < pp.Pt.X) {
                dups = null;
                pp = p;
              } else {
                if (p.Next !== pp && p.Prev !== pp)
                  dups = p;
              }
            }
            p = p.Next;
          }
          if (dups !== null) {
            while (dups !== p) {
              if (!this.FirstIsBottomPt(p, dups))
                pp = dups;
              dups = dups.Next;
              while (ClipperLib2.IntPoint.op_Inequality(dups.Pt, pp.Pt))
                dups = dups.Next;
            }
          }
          return pp;
        };
        ClipperLib2.Clipper.prototype.GetLowermostRec = function(outRec1, outRec2) {
          if (outRec1.BottomPt === null)
            outRec1.BottomPt = this.GetBottomPt(outRec1.Pts);
          if (outRec2.BottomPt === null)
            outRec2.BottomPt = this.GetBottomPt(outRec2.Pts);
          var bPt1 = outRec1.BottomPt;
          var bPt2 = outRec2.BottomPt;
          if (bPt1.Pt.Y > bPt2.Pt.Y)
            return outRec1;
          else if (bPt1.Pt.Y < bPt2.Pt.Y)
            return outRec2;
          else if (bPt1.Pt.X < bPt2.Pt.X)
            return outRec1;
          else if (bPt1.Pt.X > bPt2.Pt.X)
            return outRec2;
          else if (bPt1.Next === bPt1)
            return outRec2;
          else if (bPt2.Next === bPt2)
            return outRec1;
          else if (this.FirstIsBottomPt(bPt1, bPt2))
            return outRec1;
          else
            return outRec2;
        };
        ClipperLib2.Clipper.prototype.OutRec1RightOfOutRec2 = function(outRec1, outRec2) {
          do {
            outRec1 = outRec1.FirstLeft;
            if (outRec1 === outRec2)
              return true;
          } while (outRec1 !== null);
          return false;
        };
        ClipperLib2.Clipper.prototype.GetOutRec = function(idx) {
          var outrec = this.m_PolyOuts[idx];
          while (outrec !== this.m_PolyOuts[outrec.Idx])
            outrec = this.m_PolyOuts[outrec.Idx];
          return outrec;
        };
        ClipperLib2.Clipper.prototype.AppendPolygon = function(e1, e2) {
          var outRec1 = this.m_PolyOuts[e1.OutIdx];
          var outRec2 = this.m_PolyOuts[e2.OutIdx];
          var holeStateRec;
          if (this.OutRec1RightOfOutRec2(outRec1, outRec2))
            holeStateRec = outRec2;
          else if (this.OutRec1RightOfOutRec2(outRec2, outRec1))
            holeStateRec = outRec1;
          else
            holeStateRec = this.GetLowermostRec(outRec1, outRec2);
          var p1_lft = outRec1.Pts;
          var p1_rt = p1_lft.Prev;
          var p2_lft = outRec2.Pts;
          var p2_rt = p2_lft.Prev;
          if (e1.Side === ClipperLib2.EdgeSide.esLeft) {
            if (e2.Side === ClipperLib2.EdgeSide.esLeft) {
              this.ReversePolyPtLinks(p2_lft);
              p2_lft.Next = p1_lft;
              p1_lft.Prev = p2_lft;
              p1_rt.Next = p2_rt;
              p2_rt.Prev = p1_rt;
              outRec1.Pts = p2_rt;
            } else {
              p2_rt.Next = p1_lft;
              p1_lft.Prev = p2_rt;
              p2_lft.Prev = p1_rt;
              p1_rt.Next = p2_lft;
              outRec1.Pts = p2_lft;
            }
          } else {
            if (e2.Side === ClipperLib2.EdgeSide.esRight) {
              this.ReversePolyPtLinks(p2_lft);
              p1_rt.Next = p2_rt;
              p2_rt.Prev = p1_rt;
              p2_lft.Next = p1_lft;
              p1_lft.Prev = p2_lft;
            } else {
              p1_rt.Next = p2_lft;
              p2_lft.Prev = p1_rt;
              p1_lft.Prev = p2_rt;
              p2_rt.Next = p1_lft;
            }
          }
          outRec1.BottomPt = null;
          if (holeStateRec === outRec2) {
            if (outRec2.FirstLeft !== outRec1)
              outRec1.FirstLeft = outRec2.FirstLeft;
            outRec1.IsHole = outRec2.IsHole;
          }
          outRec2.Pts = null;
          outRec2.BottomPt = null;
          outRec2.FirstLeft = outRec1;
          var OKIdx = e1.OutIdx;
          var ObsoleteIdx = e2.OutIdx;
          e1.OutIdx = -1;
          e2.OutIdx = -1;
          var e = this.m_ActiveEdges;
          while (e !== null) {
            if (e.OutIdx === ObsoleteIdx) {
              e.OutIdx = OKIdx;
              e.Side = e1.Side;
              break;
            }
            e = e.NextInAEL;
          }
          outRec2.Idx = outRec1.Idx;
        };
        ClipperLib2.Clipper.prototype.ReversePolyPtLinks = function(pp) {
          if (pp === null)
            return;
          var pp1;
          var pp2;
          pp1 = pp;
          do {
            pp2 = pp1.Next;
            pp1.Next = pp1.Prev;
            pp1.Prev = pp2;
            pp1 = pp2;
          } while (pp1 !== pp);
        };
        ClipperLib2.Clipper.SwapSides = function(edge1, edge2) {
          var side = edge1.Side;
          edge1.Side = edge2.Side;
          edge2.Side = side;
        };
        ClipperLib2.Clipper.SwapPolyIndexes = function(edge1, edge2) {
          var outIdx = edge1.OutIdx;
          edge1.OutIdx = edge2.OutIdx;
          edge2.OutIdx = outIdx;
        };
        ClipperLib2.Clipper.prototype.IntersectEdges = function(e1, e2, pt) {
          var e1Contributing = e1.OutIdx >= 0;
          var e2Contributing = e2.OutIdx >= 0;
          if (ClipperLib2.use_xyz)
            this.SetZ(pt, e1, e2);
          if (ClipperLib2.use_lines) {
            if (e1.WindDelta === 0 || e2.WindDelta === 0) {
              if (e1.WindDelta === 0 && e2.WindDelta === 0) return;
              else if (e1.PolyTyp === e2.PolyTyp && e1.WindDelta !== e2.WindDelta && this.m_ClipType === ClipperLib2.ClipType.ctUnion) {
                if (e1.WindDelta === 0) {
                  if (e2Contributing) {
                    this.AddOutPt(e1, pt);
                    if (e1Contributing)
                      e1.OutIdx = -1;
                  }
                } else {
                  if (e1Contributing) {
                    this.AddOutPt(e2, pt);
                    if (e2Contributing)
                      e2.OutIdx = -1;
                  }
                }
              } else if (e1.PolyTyp !== e2.PolyTyp) {
                if (e1.WindDelta === 0 && Math.abs(e2.WindCnt) === 1 && (this.m_ClipType !== ClipperLib2.ClipType.ctUnion || e2.WindCnt2 === 0)) {
                  this.AddOutPt(e1, pt);
                  if (e1Contributing)
                    e1.OutIdx = -1;
                } else if (e2.WindDelta === 0 && Math.abs(e1.WindCnt) === 1 && (this.m_ClipType !== ClipperLib2.ClipType.ctUnion || e1.WindCnt2 === 0)) {
                  this.AddOutPt(e2, pt);
                  if (e2Contributing)
                    e2.OutIdx = -1;
                }
              }
              return;
            }
          }
          if (e1.PolyTyp === e2.PolyTyp) {
            if (this.IsEvenOddFillType(e1)) {
              var oldE1WindCnt = e1.WindCnt;
              e1.WindCnt = e2.WindCnt;
              e2.WindCnt = oldE1WindCnt;
            } else {
              if (e1.WindCnt + e2.WindDelta === 0)
                e1.WindCnt = -e1.WindCnt;
              else
                e1.WindCnt += e2.WindDelta;
              if (e2.WindCnt - e1.WindDelta === 0)
                e2.WindCnt = -e2.WindCnt;
              else
                e2.WindCnt -= e1.WindDelta;
            }
          } else {
            if (!this.IsEvenOddFillType(e2))
              e1.WindCnt2 += e2.WindDelta;
            else
              e1.WindCnt2 = e1.WindCnt2 === 0 ? 1 : 0;
            if (!this.IsEvenOddFillType(e1))
              e2.WindCnt2 -= e1.WindDelta;
            else
              e2.WindCnt2 = e2.WindCnt2 === 0 ? 1 : 0;
          }
          var e1FillType, e2FillType, e1FillType2, e2FillType2;
          if (e1.PolyTyp === ClipperLib2.PolyType.ptSubject) {
            e1FillType = this.m_SubjFillType;
            e1FillType2 = this.m_ClipFillType;
          } else {
            e1FillType = this.m_ClipFillType;
            e1FillType2 = this.m_SubjFillType;
          }
          if (e2.PolyTyp === ClipperLib2.PolyType.ptSubject) {
            e2FillType = this.m_SubjFillType;
            e2FillType2 = this.m_ClipFillType;
          } else {
            e2FillType = this.m_ClipFillType;
            e2FillType2 = this.m_SubjFillType;
          }
          var e1Wc, e2Wc;
          switch (e1FillType) {
            case ClipperLib2.PolyFillType.pftPositive:
              e1Wc = e1.WindCnt;
              break;
            case ClipperLib2.PolyFillType.pftNegative:
              e1Wc = -e1.WindCnt;
              break;
            default:
              e1Wc = Math.abs(e1.WindCnt);
              break;
          }
          switch (e2FillType) {
            case ClipperLib2.PolyFillType.pftPositive:
              e2Wc = e2.WindCnt;
              break;
            case ClipperLib2.PolyFillType.pftNegative:
              e2Wc = -e2.WindCnt;
              break;
            default:
              e2Wc = Math.abs(e2.WindCnt);
              break;
          }
          if (e1Contributing && e2Contributing) {
            if (e1Wc !== 0 && e1Wc !== 1 || e2Wc !== 0 && e2Wc !== 1 || e1.PolyTyp !== e2.PolyTyp && this.m_ClipType !== ClipperLib2.ClipType.ctXor) {
              this.AddLocalMaxPoly(e1, e2, pt);
            } else {
              this.AddOutPt(e1, pt);
              this.AddOutPt(e2, pt);
              ClipperLib2.Clipper.SwapSides(e1, e2);
              ClipperLib2.Clipper.SwapPolyIndexes(e1, e2);
            }
          } else if (e1Contributing) {
            if (e2Wc === 0 || e2Wc === 1) {
              this.AddOutPt(e1, pt);
              ClipperLib2.Clipper.SwapSides(e1, e2);
              ClipperLib2.Clipper.SwapPolyIndexes(e1, e2);
            }
          } else if (e2Contributing) {
            if (e1Wc === 0 || e1Wc === 1) {
              this.AddOutPt(e2, pt);
              ClipperLib2.Clipper.SwapSides(e1, e2);
              ClipperLib2.Clipper.SwapPolyIndexes(e1, e2);
            }
          } else if ((e1Wc === 0 || e1Wc === 1) && (e2Wc === 0 || e2Wc === 1)) {
            var e1Wc2, e2Wc2;
            switch (e1FillType2) {
              case ClipperLib2.PolyFillType.pftPositive:
                e1Wc2 = e1.WindCnt2;
                break;
              case ClipperLib2.PolyFillType.pftNegative:
                e1Wc2 = -e1.WindCnt2;
                break;
              default:
                e1Wc2 = Math.abs(e1.WindCnt2);
                break;
            }
            switch (e2FillType2) {
              case ClipperLib2.PolyFillType.pftPositive:
                e2Wc2 = e2.WindCnt2;
                break;
              case ClipperLib2.PolyFillType.pftNegative:
                e2Wc2 = -e2.WindCnt2;
                break;
              default:
                e2Wc2 = Math.abs(e2.WindCnt2);
                break;
            }
            if (e1.PolyTyp !== e2.PolyTyp) {
              this.AddLocalMinPoly(e1, e2, pt);
            } else if (e1Wc === 1 && e2Wc === 1)
              switch (this.m_ClipType) {
                case ClipperLib2.ClipType.ctIntersection:
                  if (e1Wc2 > 0 && e2Wc2 > 0)
                    this.AddLocalMinPoly(e1, e2, pt);
                  break;
                case ClipperLib2.ClipType.ctUnion:
                  if (e1Wc2 <= 0 && e2Wc2 <= 0)
                    this.AddLocalMinPoly(e1, e2, pt);
                  break;
                case ClipperLib2.ClipType.ctDifference:
                  if (e1.PolyTyp === ClipperLib2.PolyType.ptClip && e1Wc2 > 0 && e2Wc2 > 0 || e1.PolyTyp === ClipperLib2.PolyType.ptSubject && e1Wc2 <= 0 && e2Wc2 <= 0)
                    this.AddLocalMinPoly(e1, e2, pt);
                  break;
                case ClipperLib2.ClipType.ctXor:
                  this.AddLocalMinPoly(e1, e2, pt);
                  break;
              }
            else
              ClipperLib2.Clipper.SwapSides(e1, e2);
          }
        };
        ClipperLib2.Clipper.prototype.DeleteFromSEL = function(e) {
          var SelPrev = e.PrevInSEL;
          var SelNext = e.NextInSEL;
          if (SelPrev === null && SelNext === null && e !== this.m_SortedEdges)
            return;
          if (SelPrev !== null)
            SelPrev.NextInSEL = SelNext;
          else
            this.m_SortedEdges = SelNext;
          if (SelNext !== null)
            SelNext.PrevInSEL = SelPrev;
          e.NextInSEL = null;
          e.PrevInSEL = null;
        };
        ClipperLib2.Clipper.prototype.ProcessHorizontals = function() {
          var horzEdge = {};
          while (this.PopEdgeFromSEL(horzEdge)) {
            this.ProcessHorizontal(horzEdge.v);
          }
        };
        ClipperLib2.Clipper.prototype.GetHorzDirection = function(HorzEdge, $var) {
          if (HorzEdge.Bot.X < HorzEdge.Top.X) {
            $var.Left = HorzEdge.Bot.X;
            $var.Right = HorzEdge.Top.X;
            $var.Dir = ClipperLib2.Direction.dLeftToRight;
          } else {
            $var.Left = HorzEdge.Top.X;
            $var.Right = HorzEdge.Bot.X;
            $var.Dir = ClipperLib2.Direction.dRightToLeft;
          }
        };
        ClipperLib2.Clipper.prototype.ProcessHorizontal = function(horzEdge) {
          var $var = {
            Dir: null,
            Left: null,
            Right: null
          };
          this.GetHorzDirection(horzEdge, $var);
          var dir = $var.Dir;
          var horzLeft = $var.Left;
          var horzRight = $var.Right;
          var IsOpen = horzEdge.WindDelta === 0;
          var eLastHorz = horzEdge, eMaxPair = null;
          while (eLastHorz.NextInLML !== null && ClipperLib2.ClipperBase.IsHorizontal(eLastHorz.NextInLML))
            eLastHorz = eLastHorz.NextInLML;
          if (eLastHorz.NextInLML === null)
            eMaxPair = this.GetMaximaPair(eLastHorz);
          var currMax = this.m_Maxima;
          if (currMax !== null) {
            if (dir === ClipperLib2.Direction.dLeftToRight) {
              while (currMax !== null && currMax.X <= horzEdge.Bot.X) {
                currMax = currMax.Next;
              }
              if (currMax !== null && currMax.X >= eLastHorz.Top.X) {
                currMax = null;
              }
            } else {
              while (currMax.Next !== null && currMax.Next.X < horzEdge.Bot.X) {
                currMax = currMax.Next;
              }
              if (currMax.X <= eLastHorz.Top.X) {
                currMax = null;
              }
            }
          }
          var op1 = null;
          for (; ; ) {
            var IsLastHorz = horzEdge === eLastHorz;
            var e = this.GetNextInAEL(horzEdge, dir);
            while (e !== null) {
              if (currMax !== null) {
                if (dir === ClipperLib2.Direction.dLeftToRight) {
                  while (currMax !== null && currMax.X < e.Curr.X) {
                    if (horzEdge.OutIdx >= 0 && !IsOpen) {
                      this.AddOutPt(horzEdge, new ClipperLib2.IntPoint2(currMax.X, horzEdge.Bot.Y));
                    }
                    currMax = currMax.Next;
                  }
                } else {
                  while (currMax !== null && currMax.X > e.Curr.X) {
                    if (horzEdge.OutIdx >= 0 && !IsOpen) {
                      this.AddOutPt(horzEdge, new ClipperLib2.IntPoint2(currMax.X, horzEdge.Bot.Y));
                    }
                    currMax = currMax.Prev;
                  }
                }
              }
              if (dir === ClipperLib2.Direction.dLeftToRight && e.Curr.X > horzRight || dir === ClipperLib2.Direction.dRightToLeft && e.Curr.X < horzLeft) {
                break;
              }
              if (e.Curr.X === horzEdge.Top.X && horzEdge.NextInLML !== null && e.Dx < horzEdge.NextInLML.Dx)
                break;
              if (horzEdge.OutIdx >= 0 && !IsOpen) {
                if (ClipperLib2.use_xyz) {
                  if (dir === ClipperLib2.Direction.dLeftToRight)
                    this.SetZ(e.Curr, horzEdge, e);
                  else this.SetZ(e.Curr, e, horzEdge);
                }
                op1 = this.AddOutPt(horzEdge, e.Curr);
                var eNextHorz = this.m_SortedEdges;
                while (eNextHorz !== null) {
                  if (eNextHorz.OutIdx >= 0 && this.HorzSegmentsOverlap(horzEdge.Bot.X, horzEdge.Top.X, eNextHorz.Bot.X, eNextHorz.Top.X)) {
                    var op2 = this.GetLastOutPt(eNextHorz);
                    this.AddJoin(op2, op1, eNextHorz.Top);
                  }
                  eNextHorz = eNextHorz.NextInSEL;
                }
                this.AddGhostJoin(op1, horzEdge.Bot);
              }
              if (e === eMaxPair && IsLastHorz) {
                if (horzEdge.OutIdx >= 0) {
                  this.AddLocalMaxPoly(horzEdge, eMaxPair, horzEdge.Top);
                }
                this.DeleteFromAEL(horzEdge);
                this.DeleteFromAEL(eMaxPair);
                return;
              }
              if (dir === ClipperLib2.Direction.dLeftToRight) {
                var Pt = new ClipperLib2.IntPoint2(e.Curr.X, horzEdge.Curr.Y);
                this.IntersectEdges(horzEdge, e, Pt);
              } else {
                var Pt = new ClipperLib2.IntPoint2(e.Curr.X, horzEdge.Curr.Y);
                this.IntersectEdges(e, horzEdge, Pt);
              }
              var eNext = this.GetNextInAEL(e, dir);
              this.SwapPositionsInAEL(horzEdge, e);
              e = eNext;
            }
            if (horzEdge.NextInLML === null || !ClipperLib2.ClipperBase.IsHorizontal(horzEdge.NextInLML)) {
              break;
            }
            horzEdge = this.UpdateEdgeIntoAEL(horzEdge);
            if (horzEdge.OutIdx >= 0) {
              this.AddOutPt(horzEdge, horzEdge.Bot);
            }
            $var = {
              Dir: dir,
              Left: horzLeft,
              Right: horzRight
            };
            this.GetHorzDirection(horzEdge, $var);
            dir = $var.Dir;
            horzLeft = $var.Left;
            horzRight = $var.Right;
          }
          if (horzEdge.OutIdx >= 0 && op1 === null) {
            op1 = this.GetLastOutPt(horzEdge);
            var eNextHorz = this.m_SortedEdges;
            while (eNextHorz !== null) {
              if (eNextHorz.OutIdx >= 0 && this.HorzSegmentsOverlap(horzEdge.Bot.X, horzEdge.Top.X, eNextHorz.Bot.X, eNextHorz.Top.X)) {
                var op2 = this.GetLastOutPt(eNextHorz);
                this.AddJoin(op2, op1, eNextHorz.Top);
              }
              eNextHorz = eNextHorz.NextInSEL;
            }
            this.AddGhostJoin(op1, horzEdge.Top);
          }
          if (horzEdge.NextInLML !== null) {
            if (horzEdge.OutIdx >= 0) {
              op1 = this.AddOutPt(horzEdge, horzEdge.Top);
              horzEdge = this.UpdateEdgeIntoAEL(horzEdge);
              if (horzEdge.WindDelta === 0) {
                return;
              }
              var ePrev = horzEdge.PrevInAEL;
              var eNext = horzEdge.NextInAEL;
              if (ePrev !== null && ePrev.Curr.X === horzEdge.Bot.X && ePrev.Curr.Y === horzEdge.Bot.Y && ePrev.WindDelta === 0 && (ePrev.OutIdx >= 0 && ePrev.Curr.Y > ePrev.Top.Y && ClipperLib2.ClipperBase.SlopesEqual3(horzEdge, ePrev, this.m_UseFullRange))) {
                var op2 = this.AddOutPt(ePrev, horzEdge.Bot);
                this.AddJoin(op1, op2, horzEdge.Top);
              } else if (eNext !== null && eNext.Curr.X === horzEdge.Bot.X && eNext.Curr.Y === horzEdge.Bot.Y && eNext.WindDelta !== 0 && eNext.OutIdx >= 0 && eNext.Curr.Y > eNext.Top.Y && ClipperLib2.ClipperBase.SlopesEqual3(horzEdge, eNext, this.m_UseFullRange)) {
                var op2 = this.AddOutPt(eNext, horzEdge.Bot);
                this.AddJoin(op1, op2, horzEdge.Top);
              }
            } else {
              horzEdge = this.UpdateEdgeIntoAEL(horzEdge);
            }
          } else {
            if (horzEdge.OutIdx >= 0) {
              this.AddOutPt(horzEdge, horzEdge.Top);
            }
            this.DeleteFromAEL(horzEdge);
          }
        };
        ClipperLib2.Clipper.prototype.GetNextInAEL = function(e, Direction) {
          return Direction === ClipperLib2.Direction.dLeftToRight ? e.NextInAEL : e.PrevInAEL;
        };
        ClipperLib2.Clipper.prototype.IsMinima = function(e) {
          return e !== null && e.Prev.NextInLML !== e && e.Next.NextInLML !== e;
        };
        ClipperLib2.Clipper.prototype.IsMaxima = function(e, Y) {
          return e !== null && e.Top.Y === Y && e.NextInLML === null;
        };
        ClipperLib2.Clipper.prototype.IsIntermediate = function(e, Y) {
          return e.Top.Y === Y && e.NextInLML !== null;
        };
        ClipperLib2.Clipper.prototype.GetMaximaPair = function(e) {
          if (ClipperLib2.IntPoint.op_Equality(e.Next.Top, e.Top) && e.Next.NextInLML === null) {
            return e.Next;
          } else {
            if (ClipperLib2.IntPoint.op_Equality(e.Prev.Top, e.Top) && e.Prev.NextInLML === null) {
              return e.Prev;
            } else {
              return null;
            }
          }
        };
        ClipperLib2.Clipper.prototype.GetMaximaPairEx = function(e) {
          var result = this.GetMaximaPair(e);
          if (result === null || result.OutIdx === ClipperLib2.ClipperBase.Skip || result.NextInAEL === result.PrevInAEL && !ClipperLib2.ClipperBase.IsHorizontal(result)) {
            return null;
          }
          return result;
        };
        ClipperLib2.Clipper.prototype.ProcessIntersections = function(topY) {
          if (this.m_ActiveEdges === null)
            return true;
          try {
            this.BuildIntersectList(topY);
            if (this.m_IntersectList.length === 0)
              return true;
            if (this.m_IntersectList.length === 1 || this.FixupIntersectionOrder())
              this.ProcessIntersectList();
            else
              return false;
          } catch ($$e2) {
            this.m_SortedEdges = null;
            this.m_IntersectList.length = 0;
            ClipperLib2.Error("ProcessIntersections error");
          }
          this.m_SortedEdges = null;
          return true;
        };
        ClipperLib2.Clipper.prototype.BuildIntersectList = function(topY) {
          if (this.m_ActiveEdges === null)
            return;
          var e = this.m_ActiveEdges;
          this.m_SortedEdges = e;
          while (e !== null) {
            e.PrevInSEL = e.PrevInAEL;
            e.NextInSEL = e.NextInAEL;
            e.Curr.X = ClipperLib2.Clipper.TopX(e, topY);
            e = e.NextInAEL;
          }
          var isModified = true;
          while (isModified && this.m_SortedEdges !== null) {
            isModified = false;
            e = this.m_SortedEdges;
            while (e.NextInSEL !== null) {
              var eNext = e.NextInSEL;
              var pt = new ClipperLib2.IntPoint0();
              if (e.Curr.X > eNext.Curr.X) {
                this.IntersectPoint(e, eNext, pt);
                if (pt.Y < topY) {
                  pt = new ClipperLib2.IntPoint2(ClipperLib2.Clipper.TopX(e, topY), topY);
                }
                var newNode = new ClipperLib2.IntersectNode();
                newNode.Edge1 = e;
                newNode.Edge2 = eNext;
                newNode.Pt.X = pt.X;
                newNode.Pt.Y = pt.Y;
                if (ClipperLib2.use_xyz) newNode.Pt.Z = pt.Z;
                this.m_IntersectList.push(newNode);
                this.SwapPositionsInSEL(e, eNext);
                isModified = true;
              } else
                e = eNext;
            }
            if (e.PrevInSEL !== null)
              e.PrevInSEL.NextInSEL = null;
            else
              break;
          }
          this.m_SortedEdges = null;
        };
        ClipperLib2.Clipper.prototype.EdgesAdjacent = function(inode) {
          return inode.Edge1.NextInSEL === inode.Edge2 || inode.Edge1.PrevInSEL === inode.Edge2;
        };
        ClipperLib2.Clipper.IntersectNodeSort = function(node1, node2) {
          return node2.Pt.Y - node1.Pt.Y;
        };
        ClipperLib2.Clipper.prototype.FixupIntersectionOrder = function() {
          this.m_IntersectList.sort(this.m_IntersectNodeComparer);
          this.CopyAELToSEL();
          var cnt = this.m_IntersectList.length;
          for (var i = 0; i < cnt; i++) {
            if (!this.EdgesAdjacent(this.m_IntersectList[i])) {
              var j = i + 1;
              while (j < cnt && !this.EdgesAdjacent(this.m_IntersectList[j]))
                j++;
              if (j === cnt)
                return false;
              var tmp = this.m_IntersectList[i];
              this.m_IntersectList[i] = this.m_IntersectList[j];
              this.m_IntersectList[j] = tmp;
            }
            this.SwapPositionsInSEL(this.m_IntersectList[i].Edge1, this.m_IntersectList[i].Edge2);
          }
          return true;
        };
        ClipperLib2.Clipper.prototype.ProcessIntersectList = function() {
          for (var i = 0, ilen = this.m_IntersectList.length; i < ilen; i++) {
            var iNode = this.m_IntersectList[i];
            this.IntersectEdges(iNode.Edge1, iNode.Edge2, iNode.Pt);
            this.SwapPositionsInAEL(iNode.Edge1, iNode.Edge2);
          }
          this.m_IntersectList.length = 0;
        };
        var R1 = function(a) {
          return a < 0 ? Math.ceil(a - 0.5) : Math.round(a);
        };
        var R2 = function(a) {
          return a < 0 ? Math.ceil(a - 0.5) : Math.floor(a + 0.5);
        };
        var R3 = function(a) {
          return a < 0 ? -Math.round(Math.abs(a)) : Math.round(a);
        };
        var R4 = function(a) {
          if (a < 0) {
            a -= 0.5;
            return a < -2147483648 ? Math.ceil(a) : a | 0;
          } else {
            a += 0.5;
            return a > 2147483647 ? Math.floor(a) : a | 0;
          }
        };
        if (browser.msie) ClipperLib2.Clipper.Round = R1;
        else if (browser.chromium) ClipperLib2.Clipper.Round = R3;
        else if (browser.safari) ClipperLib2.Clipper.Round = R4;
        else ClipperLib2.Clipper.Round = R2;
        ClipperLib2.Clipper.TopX = function(edge, currentY) {
          if (currentY === edge.Top.Y)
            return edge.Top.X;
          return edge.Bot.X + ClipperLib2.Clipper.Round(edge.Dx * (currentY - edge.Bot.Y));
        };
        ClipperLib2.Clipper.prototype.IntersectPoint = function(edge1, edge2, ip) {
          ip.X = 0;
          ip.Y = 0;
          var b1, b2;
          if (edge1.Dx === edge2.Dx) {
            ip.Y = edge1.Curr.Y;
            ip.X = ClipperLib2.Clipper.TopX(edge1, ip.Y);
            return;
          }
          if (edge1.Delta.X === 0) {
            ip.X = edge1.Bot.X;
            if (ClipperLib2.ClipperBase.IsHorizontal(edge2)) {
              ip.Y = edge2.Bot.Y;
            } else {
              b2 = edge2.Bot.Y - edge2.Bot.X / edge2.Dx;
              ip.Y = ClipperLib2.Clipper.Round(ip.X / edge2.Dx + b2);
            }
          } else if (edge2.Delta.X === 0) {
            ip.X = edge2.Bot.X;
            if (ClipperLib2.ClipperBase.IsHorizontal(edge1)) {
              ip.Y = edge1.Bot.Y;
            } else {
              b1 = edge1.Bot.Y - edge1.Bot.X / edge1.Dx;
              ip.Y = ClipperLib2.Clipper.Round(ip.X / edge1.Dx + b1);
            }
          } else {
            b1 = edge1.Bot.X - edge1.Bot.Y * edge1.Dx;
            b2 = edge2.Bot.X - edge2.Bot.Y * edge2.Dx;
            var q = (b2 - b1) / (edge1.Dx - edge2.Dx);
            ip.Y = ClipperLib2.Clipper.Round(q);
            if (Math.abs(edge1.Dx) < Math.abs(edge2.Dx))
              ip.X = ClipperLib2.Clipper.Round(edge1.Dx * q + b1);
            else
              ip.X = ClipperLib2.Clipper.Round(edge2.Dx * q + b2);
          }
          if (ip.Y < edge1.Top.Y || ip.Y < edge2.Top.Y) {
            if (edge1.Top.Y > edge2.Top.Y) {
              ip.Y = edge1.Top.Y;
              ip.X = ClipperLib2.Clipper.TopX(edge2, edge1.Top.Y);
              return ip.X < edge1.Top.X;
            } else
              ip.Y = edge2.Top.Y;
            if (Math.abs(edge1.Dx) < Math.abs(edge2.Dx))
              ip.X = ClipperLib2.Clipper.TopX(edge1, ip.Y);
            else
              ip.X = ClipperLib2.Clipper.TopX(edge2, ip.Y);
          }
          if (ip.Y > edge1.Curr.Y) {
            ip.Y = edge1.Curr.Y;
            if (Math.abs(edge1.Dx) > Math.abs(edge2.Dx))
              ip.X = ClipperLib2.Clipper.TopX(edge2, ip.Y);
            else
              ip.X = ClipperLib2.Clipper.TopX(edge1, ip.Y);
          }
        };
        ClipperLib2.Clipper.prototype.ProcessEdgesAtTopOfScanbeam = function(topY) {
          var e = this.m_ActiveEdges;
          while (e !== null) {
            var IsMaximaEdge = this.IsMaxima(e, topY);
            if (IsMaximaEdge) {
              var eMaxPair = this.GetMaximaPairEx(e);
              IsMaximaEdge = eMaxPair === null || !ClipperLib2.ClipperBase.IsHorizontal(eMaxPair);
            }
            if (IsMaximaEdge) {
              if (this.StrictlySimple) {
                this.InsertMaxima(e.Top.X);
              }
              var ePrev = e.PrevInAEL;
              this.DoMaxima(e);
              if (ePrev === null)
                e = this.m_ActiveEdges;
              else
                e = ePrev.NextInAEL;
            } else {
              if (this.IsIntermediate(e, topY) && ClipperLib2.ClipperBase.IsHorizontal(e.NextInLML)) {
                e = this.UpdateEdgeIntoAEL(e);
                if (e.OutIdx >= 0)
                  this.AddOutPt(e, e.Bot);
                this.AddEdgeToSEL(e);
              } else {
                e.Curr.X = ClipperLib2.Clipper.TopX(e, topY);
                e.Curr.Y = topY;
              }
              if (ClipperLib2.use_xyz) {
                if (e.Top.Y === topY) e.Curr.Z = e.Top.Z;
                else if (e.Bot.Y === topY) e.Curr.Z = e.Bot.Z;
                else e.Curr.Z = 0;
              }
              if (this.StrictlySimple) {
                var ePrev = e.PrevInAEL;
                if (e.OutIdx >= 0 && e.WindDelta !== 0 && ePrev !== null && ePrev.OutIdx >= 0 && ePrev.Curr.X === e.Curr.X && ePrev.WindDelta !== 0) {
                  var ip = new ClipperLib2.IntPoint1(e.Curr);
                  if (ClipperLib2.use_xyz) {
                    this.SetZ(ip, ePrev, e);
                  }
                  var op = this.AddOutPt(ePrev, ip);
                  var op2 = this.AddOutPt(e, ip);
                  this.AddJoin(op, op2, ip);
                }
              }
              e = e.NextInAEL;
            }
          }
          this.ProcessHorizontals();
          this.m_Maxima = null;
          e = this.m_ActiveEdges;
          while (e !== null) {
            if (this.IsIntermediate(e, topY)) {
              var op = null;
              if (e.OutIdx >= 0)
                op = this.AddOutPt(e, e.Top);
              e = this.UpdateEdgeIntoAEL(e);
              var ePrev = e.PrevInAEL;
              var eNext = e.NextInAEL;
              if (ePrev !== null && ePrev.Curr.X === e.Bot.X && ePrev.Curr.Y === e.Bot.Y && op !== null && ePrev.OutIdx >= 0 && ePrev.Curr.Y === ePrev.Top.Y && ClipperLib2.ClipperBase.SlopesEqual5(e.Curr, e.Top, ePrev.Curr, ePrev.Top, this.m_UseFullRange) && e.WindDelta !== 0 && ePrev.WindDelta !== 0) {
                var op2 = this.AddOutPt(ePrev2, e.Bot);
                this.AddJoin(op, op2, e.Top);
              } else if (eNext !== null && eNext.Curr.X === e.Bot.X && eNext.Curr.Y === e.Bot.Y && op !== null && eNext.OutIdx >= 0 && eNext.Curr.Y === eNext.Top.Y && ClipperLib2.ClipperBase.SlopesEqual5(e.Curr, e.Top, eNext.Curr, eNext.Top, this.m_UseFullRange) && e.WindDelta !== 0 && eNext.WindDelta !== 0) {
                var op2 = this.AddOutPt(eNext, e.Bot);
                this.AddJoin(op, op2, e.Top);
              }
            }
            e = e.NextInAEL;
          }
        };
        ClipperLib2.Clipper.prototype.DoMaxima = function(e) {
          var eMaxPair = this.GetMaximaPairEx(e);
          if (eMaxPair === null) {
            if (e.OutIdx >= 0)
              this.AddOutPt(e, e.Top);
            this.DeleteFromAEL(e);
            return;
          }
          var eNext = e.NextInAEL;
          while (eNext !== null && eNext !== eMaxPair) {
            this.IntersectEdges(e, eNext, e.Top);
            this.SwapPositionsInAEL(e, eNext);
            eNext = e.NextInAEL;
          }
          if (e.OutIdx === -1 && eMaxPair.OutIdx === -1) {
            this.DeleteFromAEL(e);
            this.DeleteFromAEL(eMaxPair);
          } else if (e.OutIdx >= 0 && eMaxPair.OutIdx >= 0) {
            if (e.OutIdx >= 0) this.AddLocalMaxPoly(e, eMaxPair, e.Top);
            this.DeleteFromAEL(e);
            this.DeleteFromAEL(eMaxPair);
          } else if (ClipperLib2.use_lines && e.WindDelta === 0) {
            if (e.OutIdx >= 0) {
              this.AddOutPt(e, e.Top);
              e.OutIdx = ClipperLib2.ClipperBase.Unassigned;
            }
            this.DeleteFromAEL(e);
            if (eMaxPair.OutIdx >= 0) {
              this.AddOutPt(eMaxPair, e.Top);
              eMaxPair.OutIdx = ClipperLib2.ClipperBase.Unassigned;
            }
            this.DeleteFromAEL(eMaxPair);
          } else
            ClipperLib2.Error("DoMaxima error");
        };
        ClipperLib2.Clipper.ReversePaths = function(polys) {
          for (var i = 0, len = polys.length; i < len; i++)
            polys[i].reverse();
        };
        ClipperLib2.Clipper.Orientation = function(poly) {
          return ClipperLib2.Clipper.Area(poly) >= 0;
        };
        ClipperLib2.Clipper.prototype.PointCount = function(pts) {
          if (pts === null)
            return 0;
          var result = 0;
          var p = pts;
          do {
            result++;
            p = p.Next;
          } while (p !== pts);
          return result;
        };
        ClipperLib2.Clipper.prototype.BuildResult = function(polyg) {
          ClipperLib2.Clear(polyg);
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            var outRec = this.m_PolyOuts[i];
            if (outRec.Pts === null)
              continue;
            var p = outRec.Pts.Prev;
            var cnt = this.PointCount(p);
            if (cnt < 2)
              continue;
            var pg = new Array(cnt);
            for (var j = 0; j < cnt; j++) {
              pg[j] = p.Pt;
              p = p.Prev;
            }
            polyg.push(pg);
          }
        };
        ClipperLib2.Clipper.prototype.BuildResult2 = function(polytree) {
          polytree.Clear();
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            var outRec = this.m_PolyOuts[i];
            var cnt = this.PointCount(outRec.Pts);
            if (outRec.IsOpen && cnt < 2 || !outRec.IsOpen && cnt < 3)
              continue;
            this.FixHoleLinkage(outRec);
            var pn = new ClipperLib2.PolyNode();
            polytree.m_AllPolys.push(pn);
            outRec.PolyNode = pn;
            pn.m_polygon.length = cnt;
            var op = outRec.Pts.Prev;
            for (var j = 0; j < cnt; j++) {
              pn.m_polygon[j] = op.Pt;
              op = op.Prev;
            }
          }
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            var outRec = this.m_PolyOuts[i];
            if (outRec.PolyNode === null)
              continue;
            else if (outRec.IsOpen) {
              outRec.PolyNode.IsOpen = true;
              polytree.AddChild(outRec.PolyNode);
            } else if (outRec.FirstLeft !== null && outRec.FirstLeft.PolyNode !== null)
              outRec.FirstLeft.PolyNode.AddChild(outRec.PolyNode);
            else
              polytree.AddChild(outRec.PolyNode);
          }
        };
        ClipperLib2.Clipper.prototype.FixupOutPolyline = function(outRec) {
          var pp = outRec.Pts;
          var lastPP = pp.Prev;
          while (pp !== lastPP) {
            pp = pp.Next;
            if (ClipperLib2.IntPoint.op_Equality(pp.Pt, pp.Prev.Pt)) {
              if (pp === lastPP) {
                lastPP = pp.Prev;
              }
              var tmpPP = pp.Prev;
              tmpPP.Next = pp.Next;
              pp.Next.Prev = tmpPP;
              pp = tmpPP;
            }
          }
          if (pp === pp.Prev) {
            outRec.Pts = null;
          }
        };
        ClipperLib2.Clipper.prototype.FixupOutPolygon = function(outRec) {
          var lastOK = null;
          outRec.BottomPt = null;
          var pp = outRec.Pts;
          var preserveCol = this.PreserveCollinear || this.StrictlySimple;
          for (; ; ) {
            if (pp.Prev === pp || pp.Prev === pp.Next) {
              outRec.Pts = null;
              return;
            }
            if (ClipperLib2.IntPoint.op_Equality(pp.Pt, pp.Next.Pt) || ClipperLib2.IntPoint.op_Equality(pp.Pt, pp.Prev.Pt) || ClipperLib2.ClipperBase.SlopesEqual4(pp.Prev.Pt, pp.Pt, pp.Next.Pt, this.m_UseFullRange) && (!preserveCol || !this.Pt2IsBetweenPt1AndPt3(pp.Prev.Pt, pp.Pt, pp.Next.Pt))) {
              lastOK = null;
              pp.Prev.Next = pp.Next;
              pp.Next.Prev = pp.Prev;
              pp = pp.Prev;
            } else if (pp === lastOK)
              break;
            else {
              if (lastOK === null)
                lastOK = pp;
              pp = pp.Next;
            }
          }
          outRec.Pts = pp;
        };
        ClipperLib2.Clipper.prototype.DupOutPt = function(outPt, InsertAfter) {
          var result = new ClipperLib2.OutPt();
          result.Pt.X = outPt.Pt.X;
          result.Pt.Y = outPt.Pt.Y;
          if (ClipperLib2.use_xyz) result.Pt.Z = outPt.Pt.Z;
          result.Idx = outPt.Idx;
          if (InsertAfter) {
            result.Next = outPt.Next;
            result.Prev = outPt;
            outPt.Next.Prev = result;
            outPt.Next = result;
          } else {
            result.Prev = outPt.Prev;
            result.Next = outPt;
            outPt.Prev.Next = result;
            outPt.Prev = result;
          }
          return result;
        };
        ClipperLib2.Clipper.prototype.GetOverlap = function(a1, a2, b1, b2, $val) {
          if (a1 < a2) {
            if (b1 < b2) {
              $val.Left = Math.max(a1, b1);
              $val.Right = Math.min(a2, b2);
            } else {
              $val.Left = Math.max(a1, b2);
              $val.Right = Math.min(a2, b1);
            }
          } else {
            if (b1 < b2) {
              $val.Left = Math.max(a2, b1);
              $val.Right = Math.min(a1, b2);
            } else {
              $val.Left = Math.max(a2, b2);
              $val.Right = Math.min(a1, b1);
            }
          }
          return $val.Left < $val.Right;
        };
        ClipperLib2.Clipper.prototype.JoinHorz = function(op1, op1b, op2, op2b, Pt, DiscardLeft) {
          var Dir1 = op1.Pt.X > op1b.Pt.X ? ClipperLib2.Direction.dRightToLeft : ClipperLib2.Direction.dLeftToRight;
          var Dir2 = op2.Pt.X > op2b.Pt.X ? ClipperLib2.Direction.dRightToLeft : ClipperLib2.Direction.dLeftToRight;
          if (Dir1 === Dir2)
            return false;
          if (Dir1 === ClipperLib2.Direction.dLeftToRight) {
            while (op1.Next.Pt.X <= Pt.X && op1.Next.Pt.X >= op1.Pt.X && op1.Next.Pt.Y === Pt.Y)
              op1 = op1.Next;
            if (DiscardLeft && op1.Pt.X !== Pt.X)
              op1 = op1.Next;
            op1b = this.DupOutPt(op1, !DiscardLeft);
            if (ClipperLib2.IntPoint.op_Inequality(op1b.Pt, Pt)) {
              op1 = op1b;
              op1.Pt.X = Pt.X;
              op1.Pt.Y = Pt.Y;
              if (ClipperLib2.use_xyz) op1.Pt.Z = Pt.Z;
              op1b = this.DupOutPt(op1, !DiscardLeft);
            }
          } else {
            while (op1.Next.Pt.X >= Pt.X && op1.Next.Pt.X <= op1.Pt.X && op1.Next.Pt.Y === Pt.Y)
              op1 = op1.Next;
            if (!DiscardLeft && op1.Pt.X !== Pt.X)
              op1 = op1.Next;
            op1b = this.DupOutPt(op1, DiscardLeft);
            if (ClipperLib2.IntPoint.op_Inequality(op1b.Pt, Pt)) {
              op1 = op1b;
              op1.Pt.X = Pt.X;
              op1.Pt.Y = Pt.Y;
              if (ClipperLib2.use_xyz) op1.Pt.Z = Pt.Z;
              op1b = this.DupOutPt(op1, DiscardLeft);
            }
          }
          if (Dir2 === ClipperLib2.Direction.dLeftToRight) {
            while (op2.Next.Pt.X <= Pt.X && op2.Next.Pt.X >= op2.Pt.X && op2.Next.Pt.Y === Pt.Y)
              op2 = op2.Next;
            if (DiscardLeft && op2.Pt.X !== Pt.X)
              op2 = op2.Next;
            op2b = this.DupOutPt(op2, !DiscardLeft);
            if (ClipperLib2.IntPoint.op_Inequality(op2b.Pt, Pt)) {
              op2 = op2b;
              op2.Pt.X = Pt.X;
              op2.Pt.Y = Pt.Y;
              if (ClipperLib2.use_xyz) op2.Pt.Z = Pt.Z;
              op2b = this.DupOutPt(op2, !DiscardLeft);
            }
          } else {
            while (op2.Next.Pt.X >= Pt.X && op2.Next.Pt.X <= op2.Pt.X && op2.Next.Pt.Y === Pt.Y)
              op2 = op2.Next;
            if (!DiscardLeft && op2.Pt.X !== Pt.X)
              op2 = op2.Next;
            op2b = this.DupOutPt(op2, DiscardLeft);
            if (ClipperLib2.IntPoint.op_Inequality(op2b.Pt, Pt)) {
              op2 = op2b;
              op2.Pt.X = Pt.X;
              op2.Pt.Y = Pt.Y;
              if (ClipperLib2.use_xyz) op2.Pt.Z = Pt.Z;
              op2b = this.DupOutPt(op2, DiscardLeft);
            }
          }
          if (Dir1 === ClipperLib2.Direction.dLeftToRight === DiscardLeft) {
            op1.Prev = op2;
            op2.Next = op1;
            op1b.Next = op2b;
            op2b.Prev = op1b;
          } else {
            op1.Next = op2;
            op2.Prev = op1;
            op1b.Prev = op2b;
            op2b.Next = op1b;
          }
          return true;
        };
        ClipperLib2.Clipper.prototype.JoinPoints = function(j, outRec1, outRec2) {
          var op1 = j.OutPt1, op1b = new ClipperLib2.OutPt();
          var op2 = j.OutPt2, op2b = new ClipperLib2.OutPt();
          var isHorizontal = j.OutPt1.Pt.Y === j.OffPt.Y;
          if (isHorizontal && ClipperLib2.IntPoint.op_Equality(j.OffPt, j.OutPt1.Pt) && ClipperLib2.IntPoint.op_Equality(j.OffPt, j.OutPt2.Pt)) {
            if (outRec1 !== outRec2) return false;
            op1b = j.OutPt1.Next;
            while (op1b !== op1 && ClipperLib2.IntPoint.op_Equality(op1b.Pt, j.OffPt))
              op1b = op1b.Next;
            var reverse1 = op1b.Pt.Y > j.OffPt.Y;
            op2b = j.OutPt2.Next;
            while (op2b !== op2 && ClipperLib2.IntPoint.op_Equality(op2b.Pt, j.OffPt))
              op2b = op2b.Next;
            var reverse2 = op2b.Pt.Y > j.OffPt.Y;
            if (reverse1 === reverse2)
              return false;
            if (reverse1) {
              op1b = this.DupOutPt(op1, false);
              op2b = this.DupOutPt(op2, true);
              op1.Prev = op2;
              op2.Next = op1;
              op1b.Next = op2b;
              op2b.Prev = op1b;
              j.OutPt1 = op1;
              j.OutPt2 = op1b;
              return true;
            } else {
              op1b = this.DupOutPt(op1, true);
              op2b = this.DupOutPt(op2, false);
              op1.Next = op2;
              op2.Prev = op1;
              op1b.Prev = op2b;
              op2b.Next = op1b;
              j.OutPt1 = op1;
              j.OutPt2 = op1b;
              return true;
            }
          } else if (isHorizontal) {
            op1b = op1;
            while (op1.Prev.Pt.Y === op1.Pt.Y && op1.Prev !== op1b && op1.Prev !== op2)
              op1 = op1.Prev;
            while (op1b.Next.Pt.Y === op1b.Pt.Y && op1b.Next !== op1 && op1b.Next !== op2)
              op1b = op1b.Next;
            if (op1b.Next === op1 || op1b.Next === op2)
              return false;
            op2b = op2;
            while (op2.Prev.Pt.Y === op2.Pt.Y && op2.Prev !== op2b && op2.Prev !== op1b)
              op2 = op2.Prev;
            while (op2b.Next.Pt.Y === op2b.Pt.Y && op2b.Next !== op2 && op2b.Next !== op1)
              op2b = op2b.Next;
            if (op2b.Next === op2 || op2b.Next === op1)
              return false;
            var $val = {
              Left: null,
              Right: null
            };
            if (!this.GetOverlap(op1.Pt.X, op1b.Pt.X, op2.Pt.X, op2b.Pt.X, $val))
              return false;
            var Left = $val.Left;
            var Right = $val.Right;
            var Pt = new ClipperLib2.IntPoint0();
            var DiscardLeftSide;
            if (op1.Pt.X >= Left && op1.Pt.X <= Right) {
              Pt.X = op1.Pt.X;
              Pt.Y = op1.Pt.Y;
              if (ClipperLib2.use_xyz) Pt.Z = op1.Pt.Z;
              DiscardLeftSide = op1.Pt.X > op1b.Pt.X;
            } else if (op2.Pt.X >= Left && op2.Pt.X <= Right) {
              Pt.X = op2.Pt.X;
              Pt.Y = op2.Pt.Y;
              if (ClipperLib2.use_xyz) Pt.Z = op2.Pt.Z;
              DiscardLeftSide = op2.Pt.X > op2b.Pt.X;
            } else if (op1b.Pt.X >= Left && op1b.Pt.X <= Right) {
              Pt.X = op1b.Pt.X;
              Pt.Y = op1b.Pt.Y;
              if (ClipperLib2.use_xyz) Pt.Z = op1b.Pt.Z;
              DiscardLeftSide = op1b.Pt.X > op1.Pt.X;
            } else {
              Pt.X = op2b.Pt.X;
              Pt.Y = op2b.Pt.Y;
              if (ClipperLib2.use_xyz) Pt.Z = op2b.Pt.Z;
              DiscardLeftSide = op2b.Pt.X > op2.Pt.X;
            }
            j.OutPt1 = op1;
            j.OutPt2 = op2;
            return this.JoinHorz(op1, op1b, op2, op2b, Pt, DiscardLeftSide);
          } else {
            op1b = op1.Next;
            while (ClipperLib2.IntPoint.op_Equality(op1b.Pt, op1.Pt) && op1b !== op1)
              op1b = op1b.Next;
            var Reverse1 = op1b.Pt.Y > op1.Pt.Y || !ClipperLib2.ClipperBase.SlopesEqual4(op1.Pt, op1b.Pt, j.OffPt, this.m_UseFullRange);
            if (Reverse1) {
              op1b = op1.Prev;
              while (ClipperLib2.IntPoint.op_Equality(op1b.Pt, op1.Pt) && op1b !== op1)
                op1b = op1b.Prev;
              if (op1b.Pt.Y > op1.Pt.Y || !ClipperLib2.ClipperBase.SlopesEqual4(op1.Pt, op1b.Pt, j.OffPt, this.m_UseFullRange))
                return false;
            }
            op2b = op2.Next;
            while (ClipperLib2.IntPoint.op_Equality(op2b.Pt, op2.Pt) && op2b !== op2)
              op2b = op2b.Next;
            var Reverse2 = op2b.Pt.Y > op2.Pt.Y || !ClipperLib2.ClipperBase.SlopesEqual4(op2.Pt, op2b.Pt, j.OffPt, this.m_UseFullRange);
            if (Reverse2) {
              op2b = op2.Prev;
              while (ClipperLib2.IntPoint.op_Equality(op2b.Pt, op2.Pt) && op2b !== op2)
                op2b = op2b.Prev;
              if (op2b.Pt.Y > op2.Pt.Y || !ClipperLib2.ClipperBase.SlopesEqual4(op2.Pt, op2b.Pt, j.OffPt, this.m_UseFullRange))
                return false;
            }
            if (op1b === op1 || op2b === op2 || op1b === op2b || outRec1 === outRec2 && Reverse1 === Reverse2)
              return false;
            if (Reverse1) {
              op1b = this.DupOutPt(op1, false);
              op2b = this.DupOutPt(op2, true);
              op1.Prev = op2;
              op2.Next = op1;
              op1b.Next = op2b;
              op2b.Prev = op1b;
              j.OutPt1 = op1;
              j.OutPt2 = op1b;
              return true;
            } else {
              op1b = this.DupOutPt(op1, true);
              op2b = this.DupOutPt(op2, false);
              op1.Next = op2;
              op2.Prev = op1;
              op1b.Prev = op2b;
              op2b.Next = op1b;
              j.OutPt1 = op1;
              j.OutPt2 = op1b;
              return true;
            }
          }
        };
        ClipperLib2.Clipper.GetBounds = function(paths) {
          var i = 0, cnt = paths.length;
          while (i < cnt && paths[i].length === 0) i++;
          if (i === cnt) return new ClipperLib2.IntRect(0, 0, 0, 0);
          var result = new ClipperLib2.IntRect();
          result.left = paths[i][0].X;
          result.right = result.left;
          result.top = paths[i][0].Y;
          result.bottom = result.top;
          for (; i < cnt; i++)
            for (var j = 0, jlen = paths[i].length; j < jlen; j++) {
              if (paths[i][j].X < result.left) result.left = paths[i][j].X;
              else if (paths[i][j].X > result.right) result.right = paths[i][j].X;
              if (paths[i][j].Y < result.top) result.top = paths[i][j].Y;
              else if (paths[i][j].Y > result.bottom) result.bottom = paths[i][j].Y;
            }
          return result;
        };
        ClipperLib2.Clipper.prototype.GetBounds2 = function(ops) {
          var opStart = ops;
          var result = new ClipperLib2.IntRect();
          result.left = ops.Pt.X;
          result.right = ops.Pt.X;
          result.top = ops.Pt.Y;
          result.bottom = ops.Pt.Y;
          ops = ops.Next;
          while (ops !== opStart) {
            if (ops.Pt.X < result.left)
              result.left = ops.Pt.X;
            if (ops.Pt.X > result.right)
              result.right = ops.Pt.X;
            if (ops.Pt.Y < result.top)
              result.top = ops.Pt.Y;
            if (ops.Pt.Y > result.bottom)
              result.bottom = ops.Pt.Y;
            ops = ops.Next;
          }
          return result;
        };
        ClipperLib2.Clipper.PointInPolygon = function(pt, path) {
          var result = 0, cnt = path.length;
          if (cnt < 3)
            return 0;
          var ip = path[0];
          for (var i = 1; i <= cnt; ++i) {
            var ipNext = i === cnt ? path[0] : path[i];
            if (ipNext.Y === pt.Y) {
              if (ipNext.X === pt.X || ip.Y === pt.Y && ipNext.X > pt.X === ip.X < pt.X)
                return -1;
            }
            if (ip.Y < pt.Y !== ipNext.Y < pt.Y) {
              if (ip.X >= pt.X) {
                if (ipNext.X > pt.X)
                  result = 1 - result;
                else {
                  var d = (ip.X - pt.X) * (ipNext.Y - pt.Y) - (ipNext.X - pt.X) * (ip.Y - pt.Y);
                  if (d === 0)
                    return -1;
                  else if (d > 0 === ipNext.Y > ip.Y)
                    result = 1 - result;
                }
              } else {
                if (ipNext.X > pt.X) {
                  var d = (ip.X - pt.X) * (ipNext.Y - pt.Y) - (ipNext.X - pt.X) * (ip.Y - pt.Y);
                  if (d === 0)
                    return -1;
                  else if (d > 0 === ipNext.Y > ip.Y)
                    result = 1 - result;
                }
              }
            }
            ip = ipNext;
          }
          return result;
        };
        ClipperLib2.Clipper.prototype.PointInPolygon = function(pt, op) {
          var result = 0;
          var startOp = op;
          var ptx = pt.X, pty = pt.Y;
          var poly0x = op.Pt.X, poly0y = op.Pt.Y;
          do {
            op = op.Next;
            var poly1x = op.Pt.X, poly1y = op.Pt.Y;
            if (poly1y === pty) {
              if (poly1x === ptx || poly0y === pty && poly1x > ptx === poly0x < ptx)
                return -1;
            }
            if (poly0y < pty !== poly1y < pty) {
              if (poly0x >= ptx) {
                if (poly1x > ptx)
                  result = 1 - result;
                else {
                  var d = (poly0x - ptx) * (poly1y - pty) - (poly1x - ptx) * (poly0y - pty);
                  if (d === 0)
                    return -1;
                  if (d > 0 === poly1y > poly0y)
                    result = 1 - result;
                }
              } else {
                if (poly1x > ptx) {
                  var d = (poly0x - ptx) * (poly1y - pty) - (poly1x - ptx) * (poly0y - pty);
                  if (d === 0)
                    return -1;
                  if (d > 0 === poly1y > poly0y)
                    result = 1 - result;
                }
              }
            }
            poly0x = poly1x;
            poly0y = poly1y;
          } while (startOp !== op);
          return result;
        };
        ClipperLib2.Clipper.prototype.Poly2ContainsPoly1 = function(outPt1, outPt2) {
          var op = outPt1;
          do {
            var res = this.PointInPolygon(op.Pt, outPt2);
            if (res >= 0)
              return res > 0;
            op = op.Next;
          } while (op !== outPt1);
          return true;
        };
        ClipperLib2.Clipper.prototype.FixupFirstLefts1 = function(OldOutRec, NewOutRec) {
          var outRec, firstLeft;
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            outRec = this.m_PolyOuts[i];
            firstLeft = ClipperLib2.Clipper.ParseFirstLeft(outRec.FirstLeft);
            if (outRec.Pts !== null && firstLeft === OldOutRec) {
              if (this.Poly2ContainsPoly1(outRec.Pts, NewOutRec.Pts))
                outRec.FirstLeft = NewOutRec;
            }
          }
        };
        ClipperLib2.Clipper.prototype.FixupFirstLefts2 = function(innerOutRec, outerOutRec) {
          var orfl = outerOutRec.FirstLeft;
          var outRec, firstLeft;
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            outRec = this.m_PolyOuts[i];
            if (outRec.Pts === null || outRec === outerOutRec || outRec === innerOutRec)
              continue;
            firstLeft = ClipperLib2.Clipper.ParseFirstLeft(outRec.FirstLeft);
            if (firstLeft !== orfl && firstLeft !== innerOutRec && firstLeft !== outerOutRec)
              continue;
            if (this.Poly2ContainsPoly1(outRec.Pts, innerOutRec.Pts))
              outRec.FirstLeft = innerOutRec;
            else if (this.Poly2ContainsPoly1(outRec.Pts, outerOutRec.Pts))
              outRec.FirstLeft = outerOutRec;
            else if (outRec.FirstLeft === innerOutRec || outRec.FirstLeft === outerOutRec)
              outRec.FirstLeft = orfl;
          }
        };
        ClipperLib2.Clipper.prototype.FixupFirstLefts3 = function(OldOutRec, NewOutRec) {
          var outRec;
          var firstLeft;
          for (var i = 0, ilen = this.m_PolyOuts.length; i < ilen; i++) {
            outRec = this.m_PolyOuts[i];
            firstLeft = ClipperLib2.Clipper.ParseFirstLeft(outRec.FirstLeft);
            if (outRec.Pts !== null && firstLeft === OldOutRec)
              outRec.FirstLeft = NewOutRec;
          }
        };
        ClipperLib2.Clipper.ParseFirstLeft = function(FirstLeft) {
          while (FirstLeft !== null && FirstLeft.Pts === null)
            FirstLeft = FirstLeft.FirstLeft;
          return FirstLeft;
        };
        ClipperLib2.Clipper.prototype.JoinCommonEdges = function() {
          for (var i = 0, ilen = this.m_Joins.length; i < ilen; i++) {
            var join = this.m_Joins[i];
            var outRec1 = this.GetOutRec(join.OutPt1.Idx);
            var outRec2 = this.GetOutRec(join.OutPt2.Idx);
            if (outRec1.Pts === null || outRec2.Pts === null)
              continue;
            if (outRec1.IsOpen || outRec2.IsOpen) {
              continue;
            }
            var holeStateRec;
            if (outRec1 === outRec2)
              holeStateRec = outRec1;
            else if (this.OutRec1RightOfOutRec2(outRec1, outRec2))
              holeStateRec = outRec2;
            else if (this.OutRec1RightOfOutRec2(outRec2, outRec1))
              holeStateRec = outRec1;
            else
              holeStateRec = this.GetLowermostRec(outRec1, outRec2);
            if (!this.JoinPoints(join, outRec1, outRec2)) continue;
            if (outRec1 === outRec2) {
              outRec1.Pts = join.OutPt1;
              outRec1.BottomPt = null;
              outRec2 = this.CreateOutRec();
              outRec2.Pts = join.OutPt2;
              this.UpdateOutPtIdxs(outRec2);
              if (this.Poly2ContainsPoly1(outRec2.Pts, outRec1.Pts)) {
                outRec2.IsHole = !outRec1.IsHole;
                outRec2.FirstLeft = outRec1;
                if (this.m_UsingPolyTree)
                  this.FixupFirstLefts2(outRec2, outRec1);
                if ((outRec2.IsHole ^ this.ReverseSolution) == this.Area$1(outRec2) > 0)
                  this.ReversePolyPtLinks(outRec2.Pts);
              } else if (this.Poly2ContainsPoly1(outRec1.Pts, outRec2.Pts)) {
                outRec2.IsHole = outRec1.IsHole;
                outRec1.IsHole = !outRec2.IsHole;
                outRec2.FirstLeft = outRec1.FirstLeft;
                outRec1.FirstLeft = outRec2;
                if (this.m_UsingPolyTree)
                  this.FixupFirstLefts2(outRec1, outRec2);
                if ((outRec1.IsHole ^ this.ReverseSolution) == this.Area$1(outRec1) > 0)
                  this.ReversePolyPtLinks(outRec1.Pts);
              } else {
                outRec2.IsHole = outRec1.IsHole;
                outRec2.FirstLeft = outRec1.FirstLeft;
                if (this.m_UsingPolyTree)
                  this.FixupFirstLefts1(outRec1, outRec2);
              }
            } else {
              outRec2.Pts = null;
              outRec2.BottomPt = null;
              outRec2.Idx = outRec1.Idx;
              outRec1.IsHole = holeStateRec.IsHole;
              if (holeStateRec === outRec2)
                outRec1.FirstLeft = outRec2.FirstLeft;
              outRec2.FirstLeft = outRec1;
              if (this.m_UsingPolyTree)
                this.FixupFirstLefts3(outRec2, outRec1);
            }
          }
        };
        ClipperLib2.Clipper.prototype.UpdateOutPtIdxs = function(outrec) {
          var op = outrec.Pts;
          do {
            op.Idx = outrec.Idx;
            op = op.Prev;
          } while (op !== outrec.Pts);
        };
        ClipperLib2.Clipper.prototype.DoSimplePolygons = function() {
          var i = 0;
          while (i < this.m_PolyOuts.length) {
            var outrec = this.m_PolyOuts[i++];
            var op = outrec.Pts;
            if (op === null || outrec.IsOpen)
              continue;
            do {
              var op2 = op.Next;
              while (op2 !== outrec.Pts) {
                if (ClipperLib2.IntPoint.op_Equality(op.Pt, op2.Pt) && op2.Next !== op && op2.Prev !== op) {
                  var op3 = op.Prev;
                  var op4 = op2.Prev;
                  op.Prev = op4;
                  op4.Next = op;
                  op2.Prev = op3;
                  op3.Next = op2;
                  outrec.Pts = op;
                  var outrec2 = this.CreateOutRec();
                  outrec2.Pts = op2;
                  this.UpdateOutPtIdxs(outrec2);
                  if (this.Poly2ContainsPoly1(outrec2.Pts, outrec.Pts)) {
                    outrec2.IsHole = !outrec.IsHole;
                    outrec2.FirstLeft = outrec;
                    if (this.m_UsingPolyTree) this.FixupFirstLefts2(outrec2, outrec);
                  } else if (this.Poly2ContainsPoly1(outrec.Pts, outrec2.Pts)) {
                    outrec2.IsHole = outrec.IsHole;
                    outrec.IsHole = !outrec2.IsHole;
                    outrec2.FirstLeft = outrec.FirstLeft;
                    outrec.FirstLeft = outrec2;
                    if (this.m_UsingPolyTree) this.FixupFirstLefts2(outrec, outrec2);
                  } else {
                    outrec2.IsHole = outrec.IsHole;
                    outrec2.FirstLeft = outrec.FirstLeft;
                    if (this.m_UsingPolyTree) this.FixupFirstLefts1(outrec, outrec2);
                  }
                  op2 = op;
                }
                op2 = op2.Next;
              }
              op = op.Next;
            } while (op !== outrec.Pts);
          }
        };
        ClipperLib2.Clipper.Area = function(poly) {
          if (!Array.isArray(poly))
            return 0;
          var cnt = poly.length;
          if (cnt < 3)
            return 0;
          var a = 0;
          for (var i = 0, j = cnt - 1; i < cnt; ++i) {
            a += (poly[j].X + poly[i].X) * (poly[j].Y - poly[i].Y);
            j = i;
          }
          return -a * 0.5;
        };
        ClipperLib2.Clipper.prototype.Area = function(op) {
          var opFirst = op;
          if (op === null) return 0;
          var a = 0;
          do {
            a = a + (op.Prev.Pt.X + op.Pt.X) * (op.Prev.Pt.Y - op.Pt.Y);
            op = op.Next;
          } while (op !== opFirst);
          return a * 0.5;
        };
        ClipperLib2.Clipper.prototype.Area$1 = function(outRec) {
          return this.Area(outRec.Pts);
        };
        ClipperLib2.Clipper.SimplifyPolygon = function(poly, fillType) {
          var result = new Array();
          var c = new ClipperLib2.Clipper(0);
          c.StrictlySimple = true;
          c.AddPath(poly, ClipperLib2.PolyType.ptSubject, true);
          c.Execute(ClipperLib2.ClipType.ctUnion, result, fillType, fillType);
          return result;
        };
        ClipperLib2.Clipper.SimplifyPolygons = function(polys, fillType) {
          if (typeof fillType === "undefined") fillType = ClipperLib2.PolyFillType.pftEvenOdd;
          var result = new Array();
          var c = new ClipperLib2.Clipper(0);
          c.StrictlySimple = true;
          c.AddPaths(polys, ClipperLib2.PolyType.ptSubject, true);
          c.Execute(ClipperLib2.ClipType.ctUnion, result, fillType, fillType);
          return result;
        };
        ClipperLib2.Clipper.DistanceSqrd = function(pt1, pt2) {
          var dx = pt1.X - pt2.X;
          var dy = pt1.Y - pt2.Y;
          return dx * dx + dy * dy;
        };
        ClipperLib2.Clipper.DistanceFromLineSqrd = function(pt, ln1, ln2) {
          var A = ln1.Y - ln2.Y;
          var B = ln2.X - ln1.X;
          var C = A * ln1.X + B * ln1.Y;
          C = A * pt.X + B * pt.Y - C;
          return C * C / (A * A + B * B);
        };
        ClipperLib2.Clipper.SlopesNearCollinear = function(pt1, pt2, pt3, distSqrd) {
          if (Math.abs(pt1.X - pt2.X) > Math.abs(pt1.Y - pt2.Y)) {
            if (pt1.X > pt2.X === pt1.X < pt3.X)
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt1, pt2, pt3) < distSqrd;
            else if (pt2.X > pt1.X === pt2.X < pt3.X)
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt2, pt1, pt3) < distSqrd;
            else
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt3, pt1, pt2) < distSqrd;
          } else {
            if (pt1.Y > pt2.Y === pt1.Y < pt3.Y)
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt1, pt2, pt3) < distSqrd;
            else if (pt2.Y > pt1.Y === pt2.Y < pt3.Y)
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt2, pt1, pt3) < distSqrd;
            else
              return ClipperLib2.Clipper.DistanceFromLineSqrd(pt3, pt1, pt2) < distSqrd;
          }
        };
        ClipperLib2.Clipper.PointsAreClose = function(pt1, pt2, distSqrd) {
          var dx = pt1.X - pt2.X;
          var dy = pt1.Y - pt2.Y;
          return dx * dx + dy * dy <= distSqrd;
        };
        ClipperLib2.Clipper.ExcludeOp = function(op) {
          var result = op.Prev;
          result.Next = op.Next;
          op.Next.Prev = result;
          result.Idx = 0;
          return result;
        };
        ClipperLib2.Clipper.CleanPolygon = function(path, distance) {
          if (typeof distance === "undefined") distance = 1.415;
          var cnt = path.length;
          if (cnt === 0)
            return new Array();
          var outPts = new Array(cnt);
          for (var i = 0; i < cnt; ++i)
            outPts[i] = new ClipperLib2.OutPt();
          for (var i = 0; i < cnt; ++i) {
            outPts[i].Pt = path[i];
            outPts[i].Next = outPts[(i + 1) % cnt];
            outPts[i].Next.Prev = outPts[i];
            outPts[i].Idx = 0;
          }
          var distSqrd = distance * distance;
          var op = outPts[0];
          while (op.Idx === 0 && op.Next !== op.Prev) {
            if (ClipperLib2.Clipper.PointsAreClose(op.Pt, op.Prev.Pt, distSqrd)) {
              op = ClipperLib2.Clipper.ExcludeOp(op);
              cnt--;
            } else if (ClipperLib2.Clipper.PointsAreClose(op.Prev.Pt, op.Next.Pt, distSqrd)) {
              ClipperLib2.Clipper.ExcludeOp(op.Next);
              op = ClipperLib2.Clipper.ExcludeOp(op);
              cnt -= 2;
            } else if (ClipperLib2.Clipper.SlopesNearCollinear(op.Prev.Pt, op.Pt, op.Next.Pt, distSqrd)) {
              op = ClipperLib2.Clipper.ExcludeOp(op);
              cnt--;
            } else {
              op.Idx = 1;
              op = op.Next;
            }
          }
          if (cnt < 3)
            cnt = 0;
          var result = new Array(cnt);
          for (var i = 0; i < cnt; ++i) {
            result[i] = new ClipperLib2.IntPoint1(op.Pt);
            op = op.Next;
          }
          outPts = null;
          return result;
        };
        ClipperLib2.Clipper.CleanPolygons = function(polys, distance) {
          var result = new Array(polys.length);
          for (var i = 0, ilen = polys.length; i < ilen; i++)
            result[i] = ClipperLib2.Clipper.CleanPolygon(polys[i], distance);
          return result;
        };
        ClipperLib2.Clipper.Minkowski = function(pattern, path, IsSum, IsClosed) {
          var delta = IsClosed ? 1 : 0;
          var polyCnt = pattern.length;
          var pathCnt = path.length;
          var result = new Array();
          if (IsSum)
            for (var i = 0; i < pathCnt; i++) {
              var p = new Array(polyCnt);
              for (var j = 0, jlen = pattern.length, ip = pattern[j]; j < jlen; j++, ip = pattern[j])
                p[j] = new ClipperLib2.IntPoint2(path[i].X + ip.X, path[i].Y + ip.Y);
              result.push(p);
            }
          else
            for (var i = 0; i < pathCnt; i++) {
              var p = new Array(polyCnt);
              for (var j = 0, jlen = pattern.length, ip = pattern[j]; j < jlen; j++, ip = pattern[j])
                p[j] = new ClipperLib2.IntPoint2(path[i].X - ip.X, path[i].Y - ip.Y);
              result.push(p);
            }
          var quads = new Array();
          for (var i = 0; i < pathCnt - 1 + delta; i++)
            for (var j = 0; j < polyCnt; j++) {
              var quad = new Array();
              quad.push(result[i % pathCnt][j % polyCnt]);
              quad.push(result[(i + 1) % pathCnt][j % polyCnt]);
              quad.push(result[(i + 1) % pathCnt][(j + 1) % polyCnt]);
              quad.push(result[i % pathCnt][(j + 1) % polyCnt]);
              if (!ClipperLib2.Clipper.Orientation(quad))
                quad.reverse();
              quads.push(quad);
            }
          return quads;
        };
        ClipperLib2.Clipper.MinkowskiSum = function(pattern, path_or_paths, pathIsClosed) {
          if (!(path_or_paths[0] instanceof Array)) {
            var path = path_or_paths;
            var paths = ClipperLib2.Clipper.Minkowski(pattern, path, true, pathIsClosed);
            var c = new ClipperLib2.Clipper();
            c.AddPaths(paths, ClipperLib2.PolyType.ptSubject, true);
            c.Execute(ClipperLib2.ClipType.ctUnion, paths, ClipperLib2.PolyFillType.pftNonZero, ClipperLib2.PolyFillType.pftNonZero);
            return paths;
          } else {
            var paths = path_or_paths;
            var solution = new ClipperLib2.Paths();
            var c = new ClipperLib2.Clipper();
            for (var i = 0; i < paths.length; ++i) {
              var tmp = ClipperLib2.Clipper.Minkowski(pattern, paths[i], true, pathIsClosed);
              c.AddPaths(tmp, ClipperLib2.PolyType.ptSubject, true);
              if (pathIsClosed) {
                var path = ClipperLib2.Clipper.TranslatePath(paths[i], pattern[0]);
                c.AddPath(path, ClipperLib2.PolyType.ptClip, true);
              }
            }
            c.Execute(
              ClipperLib2.ClipType.ctUnion,
              solution,
              ClipperLib2.PolyFillType.pftNonZero,
              ClipperLib2.PolyFillType.pftNonZero
            );
            return solution;
          }
        };
        ClipperLib2.Clipper.TranslatePath = function(path, delta) {
          var outPath = new ClipperLib2.Path();
          for (var i = 0; i < path.length; i++)
            outPath.push(new ClipperLib2.IntPoint2(path[i].X + delta.X, path[i].Y + delta.Y));
          return outPath;
        };
        ClipperLib2.Clipper.MinkowskiDiff = function(poly1, poly2) {
          var paths = ClipperLib2.Clipper.Minkowski(poly1, poly2, false, true);
          var c = new ClipperLib2.Clipper();
          c.AddPaths(paths, ClipperLib2.PolyType.ptSubject, true);
          c.Execute(ClipperLib2.ClipType.ctUnion, paths, ClipperLib2.PolyFillType.pftNonZero, ClipperLib2.PolyFillType.pftNonZero);
          return paths;
        };
        ClipperLib2.Clipper.PolyTreeToPaths = function(polytree) {
          var result = new Array();
          ClipperLib2.Clipper.AddPolyNodeToPaths(polytree, ClipperLib2.Clipper.NodeType.ntAny, result);
          return result;
        };
        ClipperLib2.Clipper.AddPolyNodeToPaths = function(polynode, nt, paths) {
          var match = true;
          switch (nt) {
            case ClipperLib2.Clipper.NodeType.ntOpen:
              return;
            case ClipperLib2.Clipper.NodeType.ntClosed:
              match = !polynode.IsOpen;
              break;
            default:
              break;
          }
          if (polynode.m_polygon.length > 0 && match)
            paths.push(polynode.m_polygon);
          for (var $i3 = 0, $t3 = polynode.Childs(), $l3 = $t3.length, pn = $t3[$i3]; $i3 < $l3; $i3++, pn = $t3[$i3])
            ClipperLib2.Clipper.AddPolyNodeToPaths(pn, nt, paths);
        };
        ClipperLib2.Clipper.OpenPathsFromPolyTree = function(polytree) {
          var result = new ClipperLib2.Paths();
          for (var i = 0, ilen = polytree.ChildCount(); i < ilen; i++)
            if (polytree.Childs()[i].IsOpen)
              result.push(polytree.Childs()[i].m_polygon);
          return result;
        };
        ClipperLib2.Clipper.ClosedPathsFromPolyTree = function(polytree) {
          var result = new ClipperLib2.Paths();
          ClipperLib2.Clipper.AddPolyNodeToPaths(polytree, ClipperLib2.Clipper.NodeType.ntClosed, result);
          return result;
        };
        Inherit(ClipperLib2.Clipper, ClipperLib2.ClipperBase);
        ClipperLib2.Clipper.NodeType = {
          ntAny: 0,
          ntOpen: 1,
          ntClosed: 2
        };
        ClipperLib2.ClipperOffset = function(miterLimit, arcTolerance) {
          if (typeof miterLimit === "undefined") miterLimit = 2;
          if (typeof arcTolerance === "undefined") arcTolerance = ClipperLib2.ClipperOffset.def_arc_tolerance;
          this.m_destPolys = new ClipperLib2.Paths();
          this.m_srcPoly = new ClipperLib2.Path();
          this.m_destPoly = new ClipperLib2.Path();
          this.m_normals = new Array();
          this.m_delta = 0;
          this.m_sinA = 0;
          this.m_sin = 0;
          this.m_cos = 0;
          this.m_miterLim = 0;
          this.m_StepsPerRad = 0;
          this.m_lowest = new ClipperLib2.IntPoint0();
          this.m_polyNodes = new ClipperLib2.PolyNode();
          this.MiterLimit = miterLimit;
          this.ArcTolerance = arcTolerance;
          this.m_lowest.X = -1;
        };
        ClipperLib2.ClipperOffset.two_pi = 6.28318530717959;
        ClipperLib2.ClipperOffset.def_arc_tolerance = 0.25;
        ClipperLib2.ClipperOffset.prototype.Clear = function() {
          ClipperLib2.Clear(this.m_polyNodes.Childs());
          this.m_lowest.X = -1;
        };
        ClipperLib2.ClipperOffset.Round = ClipperLib2.Clipper.Round;
        ClipperLib2.ClipperOffset.prototype.AddPath = function(path, joinType, endType) {
          var highI = path.length - 1;
          if (highI < 0)
            return;
          var newNode = new ClipperLib2.PolyNode();
          newNode.m_jointype = joinType;
          newNode.m_endtype = endType;
          if (endType === ClipperLib2.EndType.etClosedLine || endType === ClipperLib2.EndType.etClosedPolygon)
            while (highI > 0 && ClipperLib2.IntPoint.op_Equality(path[0], path[highI]))
              highI--;
          newNode.m_polygon.push(path[0]);
          var j = 0, k = 0;
          for (var i = 1; i <= highI; i++)
            if (ClipperLib2.IntPoint.op_Inequality(newNode.m_polygon[j], path[i])) {
              j++;
              newNode.m_polygon.push(path[i]);
              if (path[i].Y > newNode.m_polygon[k].Y || path[i].Y === newNode.m_polygon[k].Y && path[i].X < newNode.m_polygon[k].X)
                k = j;
            }
          if (endType === ClipperLib2.EndType.etClosedPolygon && j < 2) return;
          this.m_polyNodes.AddChild(newNode);
          if (endType !== ClipperLib2.EndType.etClosedPolygon)
            return;
          if (this.m_lowest.X < 0)
            this.m_lowest = new ClipperLib2.IntPoint2(this.m_polyNodes.ChildCount() - 1, k);
          else {
            var ip = this.m_polyNodes.Childs()[this.m_lowest.X].m_polygon[this.m_lowest.Y];
            if (newNode.m_polygon[k].Y > ip.Y || newNode.m_polygon[k].Y === ip.Y && newNode.m_polygon[k].X < ip.X)
              this.m_lowest = new ClipperLib2.IntPoint2(this.m_polyNodes.ChildCount() - 1, k);
          }
        };
        ClipperLib2.ClipperOffset.prototype.AddPaths = function(paths, joinType, endType) {
          for (var i = 0, ilen = paths.length; i < ilen; i++)
            this.AddPath(paths[i], joinType, endType);
        };
        ClipperLib2.ClipperOffset.prototype.FixOrientations = function() {
          if (this.m_lowest.X >= 0 && !ClipperLib2.Clipper.Orientation(this.m_polyNodes.Childs()[this.m_lowest.X].m_polygon)) {
            for (var i = 0; i < this.m_polyNodes.ChildCount(); i++) {
              var node = this.m_polyNodes.Childs()[i];
              if (node.m_endtype === ClipperLib2.EndType.etClosedPolygon || node.m_endtype === ClipperLib2.EndType.etClosedLine && ClipperLib2.Clipper.Orientation(node.m_polygon))
                node.m_polygon.reverse();
            }
          } else {
            for (var i = 0; i < this.m_polyNodes.ChildCount(); i++) {
              var node = this.m_polyNodes.Childs()[i];
              if (node.m_endtype === ClipperLib2.EndType.etClosedLine && !ClipperLib2.Clipper.Orientation(node.m_polygon))
                node.m_polygon.reverse();
            }
          }
        };
        ClipperLib2.ClipperOffset.GetUnitNormal = function(pt1, pt2) {
          var dx = pt2.X - pt1.X;
          var dy = pt2.Y - pt1.Y;
          if (dx === 0 && dy === 0)
            return new ClipperLib2.DoublePoint2(0, 0);
          var f = 1 / Math.sqrt(dx * dx + dy * dy);
          dx *= f;
          dy *= f;
          return new ClipperLib2.DoublePoint2(dy, -dx);
        };
        ClipperLib2.ClipperOffset.prototype.DoOffset = function(delta) {
          this.m_destPolys = new Array();
          this.m_delta = delta;
          if (ClipperLib2.ClipperBase.near_zero(delta)) {
            for (var i = 0; i < this.m_polyNodes.ChildCount(); i++) {
              var node = this.m_polyNodes.Childs()[i];
              if (node.m_endtype === ClipperLib2.EndType.etClosedPolygon)
                this.m_destPolys.push(node.m_polygon);
            }
            return;
          }
          if (this.MiterLimit > 2)
            this.m_miterLim = 2 / (this.MiterLimit * this.MiterLimit);
          else
            this.m_miterLim = 0.5;
          var y;
          if (this.ArcTolerance <= 0)
            y = ClipperLib2.ClipperOffset.def_arc_tolerance;
          else if (this.ArcTolerance > Math.abs(delta) * ClipperLib2.ClipperOffset.def_arc_tolerance)
            y = Math.abs(delta) * ClipperLib2.ClipperOffset.def_arc_tolerance;
          else
            y = this.ArcTolerance;
          var steps = 3.14159265358979 / Math.acos(1 - y / Math.abs(delta));
          this.m_sin = Math.sin(ClipperLib2.ClipperOffset.two_pi / steps);
          this.m_cos = Math.cos(ClipperLib2.ClipperOffset.two_pi / steps);
          this.m_StepsPerRad = steps / ClipperLib2.ClipperOffset.two_pi;
          if (delta < 0)
            this.m_sin = -this.m_sin;
          for (var i = 0; i < this.m_polyNodes.ChildCount(); i++) {
            var node = this.m_polyNodes.Childs()[i];
            this.m_srcPoly = node.m_polygon;
            var len = this.m_srcPoly.length;
            if (len === 0 || delta <= 0 && (len < 3 || node.m_endtype !== ClipperLib2.EndType.etClosedPolygon))
              continue;
            this.m_destPoly = new Array();
            if (len === 1) {
              if (node.m_jointype === ClipperLib2.JoinType.jtRound) {
                var X = 1, Y = 0;
                for (var j = 1; j <= steps; j++) {
                  this.m_destPoly.push(new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].X + X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].Y + Y * delta)));
                  var X2 = X;
                  X = X * this.m_cos - this.m_sin * Y;
                  Y = X2 * this.m_sin + Y * this.m_cos;
                }
              } else {
                var X = -1, Y = -1;
                for (var j = 0; j < 4; ++j) {
                  this.m_destPoly.push(new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].X + X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].Y + Y * delta)));
                  if (X < 0)
                    X = 1;
                  else if (Y < 0)
                    Y = 1;
                  else
                    X = -1;
                }
              }
              this.m_destPolys.push(this.m_destPoly);
              continue;
            }
            this.m_normals.length = 0;
            for (var j = 0; j < len - 1; j++)
              this.m_normals.push(ClipperLib2.ClipperOffset.GetUnitNormal(this.m_srcPoly[j], this.m_srcPoly[j + 1]));
            if (node.m_endtype === ClipperLib2.EndType.etClosedLine || node.m_endtype === ClipperLib2.EndType.etClosedPolygon)
              this.m_normals.push(ClipperLib2.ClipperOffset.GetUnitNormal(this.m_srcPoly[len - 1], this.m_srcPoly[0]));
            else
              this.m_normals.push(new ClipperLib2.DoublePoint1(this.m_normals[len - 2]));
            if (node.m_endtype === ClipperLib2.EndType.etClosedPolygon) {
              var k = len - 1;
              for (var j = 0; j < len; j++)
                k = this.OffsetPoint(j, k, node.m_jointype);
              this.m_destPolys.push(this.m_destPoly);
            } else if (node.m_endtype === ClipperLib2.EndType.etClosedLine) {
              var k = len - 1;
              for (var j = 0; j < len; j++)
                k = this.OffsetPoint(j, k, node.m_jointype);
              this.m_destPolys.push(this.m_destPoly);
              this.m_destPoly = new Array();
              var n = this.m_normals[len - 1];
              for (var j = len - 1; j > 0; j--)
                this.m_normals[j] = new ClipperLib2.DoublePoint2(-this.m_normals[j - 1].X, -this.m_normals[j - 1].Y);
              this.m_normals[0] = new ClipperLib2.DoublePoint2(-n.X, -n.Y);
              k = 0;
              for (var j = len - 1; j >= 0; j--)
                k = this.OffsetPoint(j, k, node.m_jointype);
              this.m_destPolys.push(this.m_destPoly);
            } else {
              var k = 0;
              for (var j = 1; j < len - 1; ++j)
                k = this.OffsetPoint(j, k, node.m_jointype);
              var pt1;
              if (node.m_endtype === ClipperLib2.EndType.etOpenButt) {
                var j = len - 1;
                pt1 = new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_normals[j].X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_normals[j].Y * delta));
                this.m_destPoly.push(pt1);
                pt1 = new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X - this.m_normals[j].X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y - this.m_normals[j].Y * delta));
                this.m_destPoly.push(pt1);
              } else {
                var j = len - 1;
                k = len - 2;
                this.m_sinA = 0;
                this.m_normals[j] = new ClipperLib2.DoublePoint2(-this.m_normals[j].X, -this.m_normals[j].Y);
                if (node.m_endtype === ClipperLib2.EndType.etOpenSquare)
                  this.DoSquare(j, k);
                else
                  this.DoRound(j, k);
              }
              for (var j = len - 1; j > 0; j--)
                this.m_normals[j] = new ClipperLib2.DoublePoint2(-this.m_normals[j - 1].X, -this.m_normals[j - 1].Y);
              this.m_normals[0] = new ClipperLib2.DoublePoint2(-this.m_normals[1].X, -this.m_normals[1].Y);
              k = len - 1;
              for (var j = k - 1; j > 0; --j)
                k = this.OffsetPoint(j, k, node.m_jointype);
              if (node.m_endtype === ClipperLib2.EndType.etOpenButt) {
                pt1 = new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].X - this.m_normals[0].X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].Y - this.m_normals[0].Y * delta));
                this.m_destPoly.push(pt1);
                pt1 = new ClipperLib2.IntPoint2(ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].X + this.m_normals[0].X * delta), ClipperLib2.ClipperOffset.Round(this.m_srcPoly[0].Y + this.m_normals[0].Y * delta));
                this.m_destPoly.push(pt1);
              } else {
                k = 1;
                this.m_sinA = 0;
                if (node.m_endtype === ClipperLib2.EndType.etOpenSquare)
                  this.DoSquare(0, 1);
                else
                  this.DoRound(0, 1);
              }
              this.m_destPolys.push(this.m_destPoly);
            }
          }
        };
        ClipperLib2.ClipperOffset.prototype.Execute = function() {
          var a = arguments, ispolytree = a[0] instanceof ClipperLib2.PolyTree;
          if (!ispolytree) {
            var solution = a[0], delta = a[1];
            ClipperLib2.Clear(solution);
            this.FixOrientations();
            this.DoOffset(delta);
            var clpr = new ClipperLib2.Clipper(0);
            clpr.AddPaths(this.m_destPolys, ClipperLib2.PolyType.ptSubject, true);
            if (delta > 0) {
              clpr.Execute(ClipperLib2.ClipType.ctUnion, solution, ClipperLib2.PolyFillType.pftPositive, ClipperLib2.PolyFillType.pftPositive);
            } else {
              var r = ClipperLib2.Clipper.GetBounds(this.m_destPolys);
              var outer = new ClipperLib2.Path();
              outer.push(new ClipperLib2.IntPoint2(r.left - 10, r.bottom + 10));
              outer.push(new ClipperLib2.IntPoint2(r.right + 10, r.bottom + 10));
              outer.push(new ClipperLib2.IntPoint2(r.right + 10, r.top - 10));
              outer.push(new ClipperLib2.IntPoint2(r.left - 10, r.top - 10));
              clpr.AddPath(outer, ClipperLib2.PolyType.ptSubject, true);
              clpr.ReverseSolution = true;
              clpr.Execute(ClipperLib2.ClipType.ctUnion, solution, ClipperLib2.PolyFillType.pftNegative, ClipperLib2.PolyFillType.pftNegative);
              if (solution.length > 0)
                solution.splice(0, 1);
            }
          } else {
            var solution = a[0], delta = a[1];
            solution.Clear();
            this.FixOrientations();
            this.DoOffset(delta);
            var clpr = new ClipperLib2.Clipper(0);
            clpr.AddPaths(this.m_destPolys, ClipperLib2.PolyType.ptSubject, true);
            if (delta > 0) {
              clpr.Execute(ClipperLib2.ClipType.ctUnion, solution, ClipperLib2.PolyFillType.pftPositive, ClipperLib2.PolyFillType.pftPositive);
            } else {
              var r = ClipperLib2.Clipper.GetBounds(this.m_destPolys);
              var outer = new ClipperLib2.Path();
              outer.push(new ClipperLib2.IntPoint2(r.left - 10, r.bottom + 10));
              outer.push(new ClipperLib2.IntPoint2(r.right + 10, r.bottom + 10));
              outer.push(new ClipperLib2.IntPoint2(r.right + 10, r.top - 10));
              outer.push(new ClipperLib2.IntPoint2(r.left - 10, r.top - 10));
              clpr.AddPath(outer, ClipperLib2.PolyType.ptSubject, true);
              clpr.ReverseSolution = true;
              clpr.Execute(ClipperLib2.ClipType.ctUnion, solution, ClipperLib2.PolyFillType.pftNegative, ClipperLib2.PolyFillType.pftNegative);
              if (solution.ChildCount() === 1 && solution.Childs()[0].ChildCount() > 0) {
                var outerNode = solution.Childs()[0];
                solution.Childs()[0] = outerNode.Childs()[0];
                solution.Childs()[0].m_Parent = solution;
                for (var i = 1; i < outerNode.ChildCount(); i++)
                  solution.AddChild(outerNode.Childs()[i]);
              } else
                solution.Clear();
            }
          }
        };
        ClipperLib2.ClipperOffset.prototype.OffsetPoint = function(j, k, jointype) {
          this.m_sinA = this.m_normals[k].X * this.m_normals[j].Y - this.m_normals[j].X * this.m_normals[k].Y;
          if (Math.abs(this.m_sinA * this.m_delta) < 1) {
            var cosA = this.m_normals[k].X * this.m_normals[j].X + this.m_normals[j].Y * this.m_normals[k].Y;
            if (cosA > 0) {
              this.m_destPoly.push(new ClipperLib2.IntPoint2(
                ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_normals[k].X * this.m_delta),
                ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_normals[k].Y * this.m_delta)
              ));
              return k;
            }
          } else if (this.m_sinA > 1)
            this.m_sinA = 1;
          else if (this.m_sinA < -1)
            this.m_sinA = -1;
          if (this.m_sinA * this.m_delta < 0) {
            this.m_destPoly.push(new ClipperLib2.IntPoint2(
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_normals[k].X * this.m_delta),
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_normals[k].Y * this.m_delta)
            ));
            this.m_destPoly.push(new ClipperLib2.IntPoint1(this.m_srcPoly[j]));
            this.m_destPoly.push(new ClipperLib2.IntPoint2(
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_normals[j].X * this.m_delta),
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_normals[j].Y * this.m_delta)
            ));
          } else
            switch (jointype) {
              case ClipperLib2.JoinType.jtMiter: {
                var r = 1 + (this.m_normals[j].X * this.m_normals[k].X + this.m_normals[j].Y * this.m_normals[k].Y);
                if (r >= this.m_miterLim)
                  this.DoMiter(j, k, r);
                else
                  this.DoSquare(j, k);
                break;
              }
              case ClipperLib2.JoinType.jtSquare:
                this.DoSquare(j, k);
                break;
              case ClipperLib2.JoinType.jtRound:
                this.DoRound(j, k);
                break;
            }
          k = j;
          return k;
        };
        ClipperLib2.ClipperOffset.prototype.DoSquare = function(j, k) {
          var dx = Math.tan(Math.atan2(
            this.m_sinA,
            this.m_normals[k].X * this.m_normals[j].X + this.m_normals[k].Y * this.m_normals[j].Y
          ) / 4);
          this.m_destPoly.push(new ClipperLib2.IntPoint2(
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_delta * (this.m_normals[k].X - this.m_normals[k].Y * dx)),
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_delta * (this.m_normals[k].Y + this.m_normals[k].X * dx))
          ));
          this.m_destPoly.push(new ClipperLib2.IntPoint2(
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_delta * (this.m_normals[j].X + this.m_normals[j].Y * dx)),
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_delta * (this.m_normals[j].Y - this.m_normals[j].X * dx))
          ));
        };
        ClipperLib2.ClipperOffset.prototype.DoMiter = function(j, k, r) {
          var q = this.m_delta / r;
          this.m_destPoly.push(new ClipperLib2.IntPoint2(
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + (this.m_normals[k].X + this.m_normals[j].X) * q),
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + (this.m_normals[k].Y + this.m_normals[j].Y) * q)
          ));
        };
        ClipperLib2.ClipperOffset.prototype.DoRound = function(j, k) {
          var a = Math.atan2(
            this.m_sinA,
            this.m_normals[k].X * this.m_normals[j].X + this.m_normals[k].Y * this.m_normals[j].Y
          );
          var steps = Math.max(ClipperLib2.Cast_Int32(ClipperLib2.ClipperOffset.Round(this.m_StepsPerRad * Math.abs(a))), 1);
          var X = this.m_normals[k].X, Y = this.m_normals[k].Y, X2;
          for (var i = 0; i < steps; ++i) {
            this.m_destPoly.push(new ClipperLib2.IntPoint2(
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + X * this.m_delta),
              ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + Y * this.m_delta)
            ));
            X2 = X;
            X = X * this.m_cos - this.m_sin * Y;
            Y = X2 * this.m_sin + Y * this.m_cos;
          }
          this.m_destPoly.push(new ClipperLib2.IntPoint2(
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].X + this.m_normals[j].X * this.m_delta),
            ClipperLib2.ClipperOffset.Round(this.m_srcPoly[j].Y + this.m_normals[j].Y * this.m_delta)
          ));
        };
        ClipperLib2.Error = function(message) {
          try {
            throw new Error(message);
          } catch (err) {
            alert(err.message);
          }
        };
        ClipperLib2.JS = {};
        ClipperLib2.JS.AreaOfPolygon = function(poly, scale) {
          if (!scale) scale = 1;
          return ClipperLib2.Clipper.Area(poly) / (scale * scale);
        };
        ClipperLib2.JS.AreaOfPolygons = function(poly, scale) {
          if (!scale) scale = 1;
          var area = 0;
          for (var i = 0; i < poly.length; i++) {
            area += ClipperLib2.Clipper.Area(poly[i]);
          }
          return area / (scale * scale);
        };
        ClipperLib2.JS.BoundsOfPath = function(path, scale) {
          return ClipperLib2.JS.BoundsOfPaths([path], scale);
        };
        ClipperLib2.JS.BoundsOfPaths = function(paths, scale) {
          if (!scale) scale = 1;
          var bounds = ClipperLib2.Clipper.GetBounds(paths);
          bounds.left /= scale;
          bounds.bottom /= scale;
          bounds.right /= scale;
          bounds.top /= scale;
          return bounds;
        };
        ClipperLib2.JS.Clean = function(polygon, delta) {
          if (!(polygon instanceof Array)) return [];
          var isPolygons = polygon[0] instanceof Array;
          var polygon = ClipperLib2.JS.Clone(polygon);
          if (typeof delta !== "number" || delta === null) {
            ClipperLib2.Error("Delta is not a number in Clean().");
            return polygon;
          }
          if (polygon.length === 0 || polygon.length === 1 && polygon[0].length === 0 || delta < 0) return polygon;
          if (!isPolygons) polygon = [polygon];
          var k_length = polygon.length;
          var len, poly, result, d, p, j, i;
          var results = [];
          for (var k = 0; k < k_length; k++) {
            poly = polygon[k];
            len = poly.length;
            if (len === 0) continue;
            else if (len < 3) {
              result = poly;
              results.push(result);
              continue;
            }
            result = poly;
            d = delta * delta;
            p = poly[0];
            j = 1;
            for (i = 1; i < len; i++) {
              if ((poly[i].X - p.X) * (poly[i].X - p.X) + (poly[i].Y - p.Y) * (poly[i].Y - p.Y) <= d)
                continue;
              result[j] = poly[i];
              p = poly[i];
              j++;
            }
            p = poly[j - 1];
            if ((poly[0].X - p.X) * (poly[0].X - p.X) + (poly[0].Y - p.Y) * (poly[0].Y - p.Y) <= d)
              j--;
            if (j < len)
              result.splice(j, len - j);
            if (result.length) results.push(result);
          }
          if (!isPolygons && results.length) results = results[0];
          else if (!isPolygons && results.length === 0) results = [];
          else if (isPolygons && results.length === 0) results = [
            []
          ];
          return results;
        };
        ClipperLib2.JS.Clone = function(polygon) {
          if (!(polygon instanceof Array)) return [];
          if (polygon.length === 0) return [];
          else if (polygon.length === 1 && polygon[0].length === 0) return [
            []
          ];
          var isPolygons = polygon[0] instanceof Array;
          if (!isPolygons) polygon = [polygon];
          var len = polygon.length, plen, i, j, result;
          var results = new Array(len);
          for (i = 0; i < len; i++) {
            plen = polygon[i].length;
            result = new Array(plen);
            for (j = 0; j < plen; j++) {
              result[j] = {
                X: polygon[i][j].X,
                Y: polygon[i][j].Y
              };
            }
            results[i] = result;
          }
          if (!isPolygons) results = results[0];
          return results;
        };
        ClipperLib2.JS.Lighten = function(polygon, tolerance) {
          if (!(polygon instanceof Array)) return [];
          if (typeof tolerance !== "number" || tolerance === null) {
            ClipperLib2.Error("Tolerance is not a number in Lighten().");
            return ClipperLib2.JS.Clone(polygon);
          }
          if (polygon.length === 0 || polygon.length === 1 && polygon[0].length === 0 || tolerance < 0) {
            return ClipperLib2.JS.Clone(polygon);
          }
          var isPolygons = polygon[0] instanceof Array;
          if (!isPolygons) polygon = [polygon];
          var i, j, poly, k, poly2, plen, A, B, P, d, rem, addlast;
          var bxax, byay, l, ax, ay;
          var len = polygon.length;
          var toleranceSq = tolerance * tolerance;
          var results = [];
          for (i = 0; i < len; i++) {
            poly = polygon[i];
            plen = poly.length;
            if (plen === 0) continue;
            for (k = 0; k < 1e6; k++) {
              poly2 = [];
              plen = poly.length;
              if (poly[plen - 1].X !== poly[0].X || poly[plen - 1].Y !== poly[0].Y) {
                addlast = 1;
                poly.push(
                  {
                    X: poly[0].X,
                    Y: poly[0].Y
                  }
                );
                plen = poly.length;
              } else addlast = 0;
              rem = [];
              for (j = 0; j < plen - 2; j++) {
                A = poly[j];
                P = poly[j + 1];
                B = poly[j + 2];
                ax = A.X;
                ay = A.Y;
                bxax = B.X - ax;
                byay = B.Y - ay;
                if (bxax !== 0 || byay !== 0) {
                  l = ((P.X - ax) * bxax + (P.Y - ay) * byay) / (bxax * bxax + byay * byay);
                  if (l > 1) {
                    ax = B.X;
                    ay = B.Y;
                  } else if (l > 0) {
                    ax += bxax * l;
                    ay += byay * l;
                  }
                }
                bxax = P.X - ax;
                byay = P.Y - ay;
                d = bxax * bxax + byay * byay;
                if (d <= toleranceSq) {
                  rem[j + 1] = 1;
                  j++;
                }
              }
              poly2.push(
                {
                  X: poly[0].X,
                  Y: poly[0].Y
                }
              );
              for (j = 1; j < plen - 1; j++)
                if (!rem[j]) poly2.push(
                  {
                    X: poly[j].X,
                    Y: poly[j].Y
                  }
                );
              poly2.push(
                {
                  X: poly[plen - 1].X,
                  Y: poly[plen - 1].Y
                }
              );
              if (addlast) poly.pop();
              if (!rem.length) break;
              else poly = poly2;
            }
            plen = poly2.length;
            if (poly2[plen - 1].X === poly2[0].X && poly2[plen - 1].Y === poly2[0].Y) {
              poly2.pop();
            }
            if (poly2.length > 2)
              results.push(poly2);
          }
          if (!isPolygons) {
            results = results[0];
          }
          if (typeof results === "undefined") {
            results = [];
          }
          return results;
        };
        ClipperLib2.JS.PerimeterOfPath = function(path, closed, scale) {
          if (typeof path === "undefined") return 0;
          var sqrt = Math.sqrt;
          var perimeter = 0;
          var p1, p2, p1x = 0, p1y = 0, p2x = 0, p2y = 0;
          var j = path.length;
          if (j < 2) return 0;
          if (closed) {
            path[j] = path[0];
            j++;
          }
          while (--j) {
            p1 = path[j];
            p1x = p1.X;
            p1y = p1.Y;
            p2 = path[j - 1];
            p2x = p2.X;
            p2y = p2.Y;
            perimeter += sqrt((p1x - p2x) * (p1x - p2x) + (p1y - p2y) * (p1y - p2y));
          }
          if (closed) path.pop();
          return perimeter / scale;
        };
        ClipperLib2.JS.PerimeterOfPaths = function(paths, closed, scale) {
          if (!scale) scale = 1;
          var perimeter = 0;
          for (var i = 0; i < paths.length; i++) {
            perimeter += ClipperLib2.JS.PerimeterOfPath(paths[i], closed, scale);
          }
          return perimeter;
        };
        ClipperLib2.JS.ScaleDownPath = function(path, scale) {
          var i, p;
          if (!scale) scale = 1;
          i = path.length;
          while (i--) {
            p = path[i];
            p.X = p.X / scale;
            p.Y = p.Y / scale;
          }
        };
        ClipperLib2.JS.ScaleDownPaths = function(paths, scale) {
          var i, j, p;
          if (!scale) scale = 1;
          i = paths.length;
          while (i--) {
            j = paths[i].length;
            while (j--) {
              p = paths[i][j];
              p.X = p.X / scale;
              p.Y = p.Y / scale;
            }
          }
        };
        ClipperLib2.JS.ScaleUpPath = function(path, scale) {
          var i, p, round = Math.round;
          if (!scale) scale = 1;
          i = path.length;
          while (i--) {
            p = path[i];
            p.X = round(p.X * scale);
            p.Y = round(p.Y * scale);
          }
        };
        ClipperLib2.JS.ScaleUpPaths = function(paths, scale) {
          var i, j, p, round = Math.round;
          if (!scale) scale = 1;
          i = paths.length;
          while (i--) {
            j = paths[i].length;
            while (j--) {
              p = paths[i][j];
              p.X = round(p.X * scale);
              p.Y = round(p.Y * scale);
            }
          }
        };
        ClipperLib2.ExPolygons = function() {
          return [];
        };
        ClipperLib2.ExPolygon = function() {
          this.outer = null;
          this.holes = null;
        };
        ClipperLib2.JS.AddOuterPolyNodeToExPolygons = function(polynode, expolygons) {
          var ep = new ClipperLib2.ExPolygon();
          ep.outer = polynode.Contour();
          var childs = polynode.Childs();
          var ilen = childs.length;
          ep.holes = new Array(ilen);
          var node, n, i, j, childs2, jlen;
          for (i = 0; i < ilen; i++) {
            node = childs[i];
            ep.holes[i] = node.Contour();
            for (j = 0, childs2 = node.Childs(), jlen = childs2.length; j < jlen; j++) {
              n = childs2[j];
              ClipperLib2.JS.AddOuterPolyNodeToExPolygons(n, expolygons);
            }
          }
          expolygons.push(ep);
        };
        ClipperLib2.JS.ExPolygonsToPaths = function(expolygons) {
          var a, i, alen, ilen;
          var paths = new ClipperLib2.Paths();
          for (a = 0, alen = expolygons.length; a < alen; a++) {
            paths.push(expolygons[a].outer);
            for (i = 0, ilen = expolygons[a].holes.length; i < ilen; i++) {
              paths.push(expolygons[a].holes[i]);
            }
          }
          return paths;
        };
        ClipperLib2.JS.PolyTreeToExPolygons = function(polytree) {
          var expolygons = new ClipperLib2.ExPolygons();
          var node, i, childs, ilen;
          for (i = 0, childs = polytree.Childs(), ilen = childs.length; i < ilen; i++) {
            node = childs[i];
            ClipperLib2.JS.AddOuterPolyNodeToExPolygons(node, expolygons);
          }
          return expolygons;
        };
      })();
    }
  });

  // node_modules/polygon-clipping/dist/polygon-clipping.umd.js
  var require_polygon_clipping_umd = __commonJS({
    "node_modules/polygon-clipping/dist/polygon-clipping.umd.js"(exports, module) {
      (function(global, factory) {
        typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : (global = typeof globalThis !== "undefined" ? globalThis : global || self, global.polygonClipping = factory());
      })(exports, function() {
        "use strict";
        function __generator(thisArg, body) {
          var _ = {
            label: 0,
            sent: function() {
              if (t[0] & 1) throw t[1];
              return t[1];
            },
            trys: [],
            ops: []
          }, f, y, t, g;
          return g = {
            next: verb(0),
            "throw": verb(1),
            "return": verb(2)
          }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
            return this;
          }), g;
          function verb(n) {
            return function(v) {
              return step([n, v]);
            };
          }
          function step(op) {
            if (f) throw new TypeError("Generator is already executing.");
            while (_) try {
              if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
              if (y = 0, t) op = [op[0] & 2, t.value];
              switch (op[0]) {
                case 0:
                case 1:
                  t = op;
                  break;
                case 4:
                  _.label++;
                  return {
                    value: op[1],
                    done: false
                  };
                case 5:
                  _.label++;
                  y = op[1];
                  op = [0];
                  continue;
                case 7:
                  op = _.ops.pop();
                  _.trys.pop();
                  continue;
                default:
                  if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                    _ = 0;
                    continue;
                  }
                  if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                    _.label = op[1];
                    break;
                  }
                  if (op[0] === 6 && _.label < t[1]) {
                    _.label = t[1];
                    t = op;
                    break;
                  }
                  if (t && _.label < t[2]) {
                    _.label = t[2];
                    _.ops.push(op);
                    break;
                  }
                  if (t[2]) _.ops.pop();
                  _.trys.pop();
                  continue;
              }
              op = body.call(thisArg, _);
            } catch (e) {
              op = [6, e];
              y = 0;
            } finally {
              f = t = 0;
            }
            if (op[0] & 5) throw op[1];
            return {
              value: op[0] ? op[1] : void 0,
              done: true
            };
          }
        }
        var Node = (
          /** @class */
          /* @__PURE__ */ function() {
            function Node2(key, data) {
              this.next = null;
              this.key = key;
              this.data = data;
              this.left = null;
              this.right = null;
            }
            return Node2;
          }()
        );
        function DEFAULT_COMPARE(a, b) {
          return a > b ? 1 : a < b ? -1 : 0;
        }
        function splay(i, t, comparator) {
          var N = new Node(null, null);
          var l = N;
          var r = N;
          while (true) {
            var cmp2 = comparator(i, t.key);
            if (cmp2 < 0) {
              if (t.left === null) break;
              if (comparator(i, t.left.key) < 0) {
                var y = t.left;
                t.left = y.right;
                y.right = t;
                t = y;
                if (t.left === null) break;
              }
              r.left = t;
              r = t;
              t = t.left;
            } else if (cmp2 > 0) {
              if (t.right === null) break;
              if (comparator(i, t.right.key) > 0) {
                var y = t.right;
                t.right = y.left;
                y.left = t;
                t = y;
                if (t.right === null) break;
              }
              l.right = t;
              l = t;
              t = t.right;
            } else break;
          }
          l.right = t.left;
          r.left = t.right;
          t.left = N.right;
          t.right = N.left;
          return t;
        }
        function insert(i, data, t, comparator) {
          var node = new Node(i, data);
          if (t === null) {
            node.left = node.right = null;
            return node;
          }
          t = splay(i, t, comparator);
          var cmp2 = comparator(i, t.key);
          if (cmp2 < 0) {
            node.left = t.left;
            node.right = t;
            t.left = null;
          } else if (cmp2 >= 0) {
            node.right = t.right;
            node.left = t;
            t.right = null;
          }
          return node;
        }
        function split(key, v, comparator) {
          var left = null;
          var right = null;
          if (v) {
            v = splay(key, v, comparator);
            var cmp2 = comparator(v.key, key);
            if (cmp2 === 0) {
              left = v.left;
              right = v.right;
            } else if (cmp2 < 0) {
              right = v.right;
              v.right = null;
              left = v;
            } else {
              left = v.left;
              v.left = null;
              right = v;
            }
          }
          return {
            left,
            right
          };
        }
        function merge(left, right, comparator) {
          if (right === null) return left;
          if (left === null) return right;
          right = splay(left.key, right, comparator);
          right.left = left;
          return right;
        }
        function printRow(root, prefix, isTail, out, printNode) {
          if (root) {
            out("" + prefix + (isTail ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ") + printNode(root) + "\n");
            var indent = prefix + (isTail ? "    " : "\u2502   ");
            if (root.left) printRow(root.left, indent, false, out, printNode);
            if (root.right) printRow(root.right, indent, true, out, printNode);
          }
        }
        var Tree = (
          /** @class */
          function() {
            function Tree2(comparator) {
              if (comparator === void 0) {
                comparator = DEFAULT_COMPARE;
              }
              this._root = null;
              this._size = 0;
              this._comparator = comparator;
            }
            Tree2.prototype.insert = function(key, data) {
              this._size++;
              return this._root = insert(key, data, this._root, this._comparator);
            };
            Tree2.prototype.add = function(key, data) {
              var node = new Node(key, data);
              if (this._root === null) {
                node.left = node.right = null;
                this._size++;
                this._root = node;
              }
              var comparator = this._comparator;
              var t = splay(key, this._root, comparator);
              var cmp2 = comparator(key, t.key);
              if (cmp2 === 0) this._root = t;
              else {
                if (cmp2 < 0) {
                  node.left = t.left;
                  node.right = t;
                  t.left = null;
                } else if (cmp2 > 0) {
                  node.right = t.right;
                  node.left = t;
                  t.right = null;
                }
                this._size++;
                this._root = node;
              }
              return this._root;
            };
            Tree2.prototype.remove = function(key) {
              this._root = this._remove(key, this._root, this._comparator);
            };
            Tree2.prototype._remove = function(i, t, comparator) {
              var x;
              if (t === null) return null;
              t = splay(i, t, comparator);
              var cmp2 = comparator(i, t.key);
              if (cmp2 === 0) {
                if (t.left === null) {
                  x = t.right;
                } else {
                  x = splay(i, t.left, comparator);
                  x.right = t.right;
                }
                this._size--;
                return x;
              }
              return t;
            };
            Tree2.prototype.pop = function() {
              var node = this._root;
              if (node) {
                while (node.left) node = node.left;
                this._root = splay(node.key, this._root, this._comparator);
                this._root = this._remove(node.key, this._root, this._comparator);
                return {
                  key: node.key,
                  data: node.data
                };
              }
              return null;
            };
            Tree2.prototype.findStatic = function(key) {
              var current = this._root;
              var compare = this._comparator;
              while (current) {
                var cmp2 = compare(key, current.key);
                if (cmp2 === 0) return current;
                else if (cmp2 < 0) current = current.left;
                else current = current.right;
              }
              return null;
            };
            Tree2.prototype.find = function(key) {
              if (this._root) {
                this._root = splay(key, this._root, this._comparator);
                if (this._comparator(key, this._root.key) !== 0) return null;
              }
              return this._root;
            };
            Tree2.prototype.contains = function(key) {
              var current = this._root;
              var compare = this._comparator;
              while (current) {
                var cmp2 = compare(key, current.key);
                if (cmp2 === 0) return true;
                else if (cmp2 < 0) current = current.left;
                else current = current.right;
              }
              return false;
            };
            Tree2.prototype.forEach = function(visitor, ctx) {
              var current = this._root;
              var Q = [];
              var done = false;
              while (!done) {
                if (current !== null) {
                  Q.push(current);
                  current = current.left;
                } else {
                  if (Q.length !== 0) {
                    current = Q.pop();
                    visitor.call(ctx, current);
                    current = current.right;
                  } else done = true;
                }
              }
              return this;
            };
            Tree2.prototype.range = function(low, high, fn, ctx) {
              var Q = [];
              var compare = this._comparator;
              var node = this._root;
              var cmp2;
              while (Q.length !== 0 || node) {
                if (node) {
                  Q.push(node);
                  node = node.left;
                } else {
                  node = Q.pop();
                  cmp2 = compare(node.key, high);
                  if (cmp2 > 0) {
                    break;
                  } else if (compare(node.key, low) >= 0) {
                    if (fn.call(ctx, node)) return this;
                  }
                  node = node.right;
                }
              }
              return this;
            };
            Tree2.prototype.keys = function() {
              var keys = [];
              this.forEach(function(_a) {
                var key = _a.key;
                return keys.push(key);
              });
              return keys;
            };
            Tree2.prototype.values = function() {
              var values = [];
              this.forEach(function(_a) {
                var data = _a.data;
                return values.push(data);
              });
              return values;
            };
            Tree2.prototype.min = function() {
              if (this._root) return this.minNode(this._root).key;
              return null;
            };
            Tree2.prototype.max = function() {
              if (this._root) return this.maxNode(this._root).key;
              return null;
            };
            Tree2.prototype.minNode = function(t) {
              if (t === void 0) {
                t = this._root;
              }
              if (t) while (t.left) t = t.left;
              return t;
            };
            Tree2.prototype.maxNode = function(t) {
              if (t === void 0) {
                t = this._root;
              }
              if (t) while (t.right) t = t.right;
              return t;
            };
            Tree2.prototype.at = function(index2) {
              var current = this._root;
              var done = false;
              var i = 0;
              var Q = [];
              while (!done) {
                if (current) {
                  Q.push(current);
                  current = current.left;
                } else {
                  if (Q.length > 0) {
                    current = Q.pop();
                    if (i === index2) return current;
                    i++;
                    current = current.right;
                  } else done = true;
                }
              }
              return null;
            };
            Tree2.prototype.next = function(d) {
              var root = this._root;
              var successor = null;
              if (d.right) {
                successor = d.right;
                while (successor.left) successor = successor.left;
                return successor;
              }
              var comparator = this._comparator;
              while (root) {
                var cmp2 = comparator(d.key, root.key);
                if (cmp2 === 0) break;
                else if (cmp2 < 0) {
                  successor = root;
                  root = root.left;
                } else root = root.right;
              }
              return successor;
            };
            Tree2.prototype.prev = function(d) {
              var root = this._root;
              var predecessor = null;
              if (d.left !== null) {
                predecessor = d.left;
                while (predecessor.right) predecessor = predecessor.right;
                return predecessor;
              }
              var comparator = this._comparator;
              while (root) {
                var cmp2 = comparator(d.key, root.key);
                if (cmp2 === 0) break;
                else if (cmp2 < 0) root = root.left;
                else {
                  predecessor = root;
                  root = root.right;
                }
              }
              return predecessor;
            };
            Tree2.prototype.clear = function() {
              this._root = null;
              this._size = 0;
              return this;
            };
            Tree2.prototype.toList = function() {
              return toList(this._root);
            };
            Tree2.prototype.load = function(keys, values, presort) {
              if (values === void 0) {
                values = [];
              }
              if (presort === void 0) {
                presort = false;
              }
              var size = keys.length;
              var comparator = this._comparator;
              if (presort) sort(keys, values, 0, size - 1, comparator);
              if (this._root === null) {
                this._root = loadRecursive(keys, values, 0, size);
                this._size = size;
              } else {
                var mergedList = mergeLists(this.toList(), createList(keys, values), comparator);
                size = this._size + size;
                this._root = sortedListToBST({
                  head: mergedList
                }, 0, size);
              }
              return this;
            };
            Tree2.prototype.isEmpty = function() {
              return this._root === null;
            };
            Object.defineProperty(Tree2.prototype, "size", {
              get: function() {
                return this._size;
              },
              enumerable: true,
              configurable: true
            });
            Object.defineProperty(Tree2.prototype, "root", {
              get: function() {
                return this._root;
              },
              enumerable: true,
              configurable: true
            });
            Tree2.prototype.toString = function(printNode) {
              if (printNode === void 0) {
                printNode = function(n) {
                  return String(n.key);
                };
              }
              var out = [];
              printRow(this._root, "", true, function(v) {
                return out.push(v);
              }, printNode);
              return out.join("");
            };
            Tree2.prototype.update = function(key, newKey, newData) {
              var comparator = this._comparator;
              var _a = split(key, this._root, comparator), left = _a.left, right = _a.right;
              if (comparator(key, newKey) < 0) {
                right = insert(newKey, newData, right, comparator);
              } else {
                left = insert(newKey, newData, left, comparator);
              }
              this._root = merge(left, right, comparator);
            };
            Tree2.prototype.split = function(key) {
              return split(key, this._root, this._comparator);
            };
            Tree2.prototype[Symbol.iterator] = function() {
              var current, Q, done;
              return __generator(this, function(_a) {
                switch (_a.label) {
                  case 0:
                    current = this._root;
                    Q = [];
                    done = false;
                    _a.label = 1;
                  case 1:
                    if (!!done) return [3, 6];
                    if (!(current !== null)) return [3, 2];
                    Q.push(current);
                    current = current.left;
                    return [3, 5];
                  case 2:
                    if (!(Q.length !== 0)) return [3, 4];
                    current = Q.pop();
                    return [4, current];
                  case 3:
                    _a.sent();
                    current = current.right;
                    return [3, 5];
                  case 4:
                    done = true;
                    _a.label = 5;
                  case 5:
                    return [3, 1];
                  case 6:
                    return [
                      2
                      /*return*/
                    ];
                }
              });
            };
            return Tree2;
          }()
        );
        function loadRecursive(keys, values, start, end) {
          var size = end - start;
          if (size > 0) {
            var middle = start + Math.floor(size / 2);
            var key = keys[middle];
            var data = values[middle];
            var node = new Node(key, data);
            node.left = loadRecursive(keys, values, start, middle);
            node.right = loadRecursive(keys, values, middle + 1, end);
            return node;
          }
          return null;
        }
        function createList(keys, values) {
          var head = new Node(null, null);
          var p = head;
          for (var i = 0; i < keys.length; i++) {
            p = p.next = new Node(keys[i], values[i]);
          }
          p.next = null;
          return head.next;
        }
        function toList(root) {
          var current = root;
          var Q = [];
          var done = false;
          var head = new Node(null, null);
          var p = head;
          while (!done) {
            if (current) {
              Q.push(current);
              current = current.left;
            } else {
              if (Q.length > 0) {
                current = p = p.next = Q.pop();
                current = current.right;
              } else done = true;
            }
          }
          p.next = null;
          return head.next;
        }
        function sortedListToBST(list, start, end) {
          var size = end - start;
          if (size > 0) {
            var middle = start + Math.floor(size / 2);
            var left = sortedListToBST(list, start, middle);
            var root = list.head;
            root.left = left;
            list.head = list.head.next;
            root.right = sortedListToBST(list, middle + 1, end);
            return root;
          }
          return null;
        }
        function mergeLists(l1, l2, compare) {
          var head = new Node(null, null);
          var p = head;
          var p1 = l1;
          var p2 = l2;
          while (p1 !== null && p2 !== null) {
            if (compare(p1.key, p2.key) < 0) {
              p.next = p1;
              p1 = p1.next;
            } else {
              p.next = p2;
              p2 = p2.next;
            }
            p = p.next;
          }
          if (p1 !== null) {
            p.next = p1;
          } else if (p2 !== null) {
            p.next = p2;
          }
          return head.next;
        }
        function sort(keys, values, left, right, compare) {
          if (left >= right) return;
          var pivot = keys[left + right >> 1];
          var i = left - 1;
          var j = right + 1;
          while (true) {
            do
              i++;
            while (compare(keys[i], pivot) < 0);
            do
              j--;
            while (compare(keys[j], pivot) > 0);
            if (i >= j) break;
            var tmp = keys[i];
            keys[i] = keys[j];
            keys[j] = tmp;
            tmp = values[i];
            values[i] = values[j];
            values[j] = tmp;
          }
          sort(keys, values, left, j, compare);
          sort(keys, values, j + 1, right, compare);
        }
        const isInBbox = (bbox, point) => {
          return bbox.ll.x <= point.x && point.x <= bbox.ur.x && bbox.ll.y <= point.y && point.y <= bbox.ur.y;
        };
        const getBboxOverlap = (b1, b2) => {
          if (b2.ur.x < b1.ll.x || b1.ur.x < b2.ll.x || b2.ur.y < b1.ll.y || b1.ur.y < b2.ll.y) return null;
          const lowerX = b1.ll.x < b2.ll.x ? b2.ll.x : b1.ll.x;
          const upperX = b1.ur.x < b2.ur.x ? b1.ur.x : b2.ur.x;
          const lowerY = b1.ll.y < b2.ll.y ? b2.ll.y : b1.ll.y;
          const upperY = b1.ur.y < b2.ur.y ? b1.ur.y : b2.ur.y;
          return {
            ll: {
              x: lowerX,
              y: lowerY
            },
            ur: {
              x: upperX,
              y: upperY
            }
          };
        };
        let epsilon$1 = Number.EPSILON;
        if (epsilon$1 === void 0) epsilon$1 = Math.pow(2, -52);
        const EPSILON_SQ = epsilon$1 * epsilon$1;
        const cmp = (a, b) => {
          if (-epsilon$1 < a && a < epsilon$1) {
            if (-epsilon$1 < b && b < epsilon$1) {
              return 0;
            }
          }
          const ab = a - b;
          if (ab * ab < EPSILON_SQ * a * b) {
            return 0;
          }
          return a < b ? -1 : 1;
        };
        class PtRounder {
          constructor() {
            this.reset();
          }
          reset() {
            this.xRounder = new CoordRounder();
            this.yRounder = new CoordRounder();
          }
          round(x, y) {
            return {
              x: this.xRounder.round(x),
              y: this.yRounder.round(y)
            };
          }
        }
        class CoordRounder {
          constructor() {
            this.tree = new Tree();
            this.round(0);
          }
          // Note: this can rounds input values backwards or forwards.
          //       You might ask, why not restrict this to just rounding
          //       forwards? Wouldn't that allow left endpoints to always
          //       remain left endpoints during splitting (never change to
          //       right). No - it wouldn't, because we snap intersections
          //       to endpoints (to establish independence from the segment
          //       angle for t-intersections).
          round(coord) {
            const node = this.tree.add(coord);
            const prevNode = this.tree.prev(node);
            if (prevNode !== null && cmp(node.key, prevNode.key) === 0) {
              this.tree.remove(coord);
              return prevNode.key;
            }
            const nextNode = this.tree.next(node);
            if (nextNode !== null && cmp(node.key, nextNode.key) === 0) {
              this.tree.remove(coord);
              return nextNode.key;
            }
            return coord;
          }
        }
        const rounder = new PtRounder();
        const epsilon = 11102230246251565e-32;
        const splitter = 134217729;
        const resulterrbound = (3 + 8 * epsilon) * epsilon;
        function sum(elen, e, flen, f, h) {
          let Q, Qnew, hh, bvirt;
          let enow = e[0];
          let fnow = f[0];
          let eindex = 0;
          let findex = 0;
          if (fnow > enow === fnow > -enow) {
            Q = enow;
            enow = e[++eindex];
          } else {
            Q = fnow;
            fnow = f[++findex];
          }
          let hindex = 0;
          if (eindex < elen && findex < flen) {
            if (fnow > enow === fnow > -enow) {
              Qnew = enow + Q;
              hh = Q - (Qnew - enow);
              enow = e[++eindex];
            } else {
              Qnew = fnow + Q;
              hh = Q - (Qnew - fnow);
              fnow = f[++findex];
            }
            Q = Qnew;
            if (hh !== 0) {
              h[hindex++] = hh;
            }
            while (eindex < elen && findex < flen) {
              if (fnow > enow === fnow > -enow) {
                Qnew = Q + enow;
                bvirt = Qnew - Q;
                hh = Q - (Qnew - bvirt) + (enow - bvirt);
                enow = e[++eindex];
              } else {
                Qnew = Q + fnow;
                bvirt = Qnew - Q;
                hh = Q - (Qnew - bvirt) + (fnow - bvirt);
                fnow = f[++findex];
              }
              Q = Qnew;
              if (hh !== 0) {
                h[hindex++] = hh;
              }
            }
          }
          while (eindex < elen) {
            Qnew = Q + enow;
            bvirt = Qnew - Q;
            hh = Q - (Qnew - bvirt) + (enow - bvirt);
            enow = e[++eindex];
            Q = Qnew;
            if (hh !== 0) {
              h[hindex++] = hh;
            }
          }
          while (findex < flen) {
            Qnew = Q + fnow;
            bvirt = Qnew - Q;
            hh = Q - (Qnew - bvirt) + (fnow - bvirt);
            fnow = f[++findex];
            Q = Qnew;
            if (hh !== 0) {
              h[hindex++] = hh;
            }
          }
          if (Q !== 0 || hindex === 0) {
            h[hindex++] = Q;
          }
          return hindex;
        }
        function estimate(elen, e) {
          let Q = e[0];
          for (let i = 1; i < elen; i++) Q += e[i];
          return Q;
        }
        function vec(n) {
          return new Float64Array(n);
        }
        const ccwerrboundA = (3 + 16 * epsilon) * epsilon;
        const ccwerrboundB = (2 + 12 * epsilon) * epsilon;
        const ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
        const B = vec(4);
        const C1 = vec(8);
        const C2 = vec(12);
        const D = vec(16);
        const u = vec(4);
        function orient2dadapt(ax, ay, bx, by, cx, cy, detsum) {
          let acxtail, acytail, bcxtail, bcytail;
          let bvirt, c, ahi, alo, bhi, blo, _i, _j, _0, s1, s0, t1, t0, u3;
          const acx = ax - cx;
          const bcx = bx - cx;
          const acy = ay - cy;
          const bcy = by - cy;
          s1 = acx * bcy;
          c = splitter * acx;
          ahi = c - (c - acx);
          alo = acx - ahi;
          c = splitter * bcy;
          bhi = c - (c - bcy);
          blo = bcy - bhi;
          s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
          t1 = acy * bcx;
          c = splitter * acy;
          ahi = c - (c - acy);
          alo = acy - ahi;
          c = splitter * bcx;
          bhi = c - (c - bcx);
          blo = bcx - bhi;
          t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
          _i = s0 - t0;
          bvirt = s0 - _i;
          B[0] = s0 - (_i + bvirt) + (bvirt - t0);
          _j = s1 + _i;
          bvirt = _j - s1;
          _0 = s1 - (_j - bvirt) + (_i - bvirt);
          _i = _0 - t1;
          bvirt = _0 - _i;
          B[1] = _0 - (_i + bvirt) + (bvirt - t1);
          u3 = _j + _i;
          bvirt = u3 - _j;
          B[2] = _j - (u3 - bvirt) + (_i - bvirt);
          B[3] = u3;
          let det = estimate(4, B);
          let errbound = ccwerrboundB * detsum;
          if (det >= errbound || -det >= errbound) {
            return det;
          }
          bvirt = ax - acx;
          acxtail = ax - (acx + bvirt) + (bvirt - cx);
          bvirt = bx - bcx;
          bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
          bvirt = ay - acy;
          acytail = ay - (acy + bvirt) + (bvirt - cy);
          bvirt = by - bcy;
          bcytail = by - (bcy + bvirt) + (bvirt - cy);
          if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) {
            return det;
          }
          errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
          det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
          if (det >= errbound || -det >= errbound) return det;
          s1 = acxtail * bcy;
          c = splitter * acxtail;
          ahi = c - (c - acxtail);
          alo = acxtail - ahi;
          c = splitter * bcy;
          bhi = c - (c - bcy);
          blo = bcy - bhi;
          s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
          t1 = acytail * bcx;
          c = splitter * acytail;
          ahi = c - (c - acytail);
          alo = acytail - ahi;
          c = splitter * bcx;
          bhi = c - (c - bcx);
          blo = bcx - bhi;
          t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
          _i = s0 - t0;
          bvirt = s0 - _i;
          u[0] = s0 - (_i + bvirt) + (bvirt - t0);
          _j = s1 + _i;
          bvirt = _j - s1;
          _0 = s1 - (_j - bvirt) + (_i - bvirt);
          _i = _0 - t1;
          bvirt = _0 - _i;
          u[1] = _0 - (_i + bvirt) + (bvirt - t1);
          u3 = _j + _i;
          bvirt = u3 - _j;
          u[2] = _j - (u3 - bvirt) + (_i - bvirt);
          u[3] = u3;
          const C1len = sum(4, B, 4, u, C1);
          s1 = acx * bcytail;
          c = splitter * acx;
          ahi = c - (c - acx);
          alo = acx - ahi;
          c = splitter * bcytail;
          bhi = c - (c - bcytail);
          blo = bcytail - bhi;
          s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
          t1 = acy * bcxtail;
          c = splitter * acy;
          ahi = c - (c - acy);
          alo = acy - ahi;
          c = splitter * bcxtail;
          bhi = c - (c - bcxtail);
          blo = bcxtail - bhi;
          t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
          _i = s0 - t0;
          bvirt = s0 - _i;
          u[0] = s0 - (_i + bvirt) + (bvirt - t0);
          _j = s1 + _i;
          bvirt = _j - s1;
          _0 = s1 - (_j - bvirt) + (_i - bvirt);
          _i = _0 - t1;
          bvirt = _0 - _i;
          u[1] = _0 - (_i + bvirt) + (bvirt - t1);
          u3 = _j + _i;
          bvirt = u3 - _j;
          u[2] = _j - (u3 - bvirt) + (_i - bvirt);
          u[3] = u3;
          const C2len = sum(C1len, C1, 4, u, C2);
          s1 = acxtail * bcytail;
          c = splitter * acxtail;
          ahi = c - (c - acxtail);
          alo = acxtail - ahi;
          c = splitter * bcytail;
          bhi = c - (c - bcytail);
          blo = bcytail - bhi;
          s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
          t1 = acytail * bcxtail;
          c = splitter * acytail;
          ahi = c - (c - acytail);
          alo = acytail - ahi;
          c = splitter * bcxtail;
          bhi = c - (c - bcxtail);
          blo = bcxtail - bhi;
          t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
          _i = s0 - t0;
          bvirt = s0 - _i;
          u[0] = s0 - (_i + bvirt) + (bvirt - t0);
          _j = s1 + _i;
          bvirt = _j - s1;
          _0 = s1 - (_j - bvirt) + (_i - bvirt);
          _i = _0 - t1;
          bvirt = _0 - _i;
          u[1] = _0 - (_i + bvirt) + (bvirt - t1);
          u3 = _j + _i;
          bvirt = u3 - _j;
          u[2] = _j - (u3 - bvirt) + (_i - bvirt);
          u[3] = u3;
          const Dlen = sum(C2len, C2, 4, u, D);
          return D[Dlen - 1];
        }
        function orient2d(ax, ay, bx, by, cx, cy) {
          const detleft = (ay - cy) * (bx - cx);
          const detright = (ax - cx) * (by - cy);
          const det = detleft - detright;
          const detsum = Math.abs(detleft + detright);
          if (Math.abs(det) >= ccwerrboundA * detsum) return det;
          return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
        }
        const crossProduct = (a, b) => a.x * b.y - a.y * b.x;
        const dotProduct = (a, b) => a.x * b.x + a.y * b.y;
        const compareVectorAngles = (basePt, endPt1, endPt2) => {
          const res = orient2d(basePt.x, basePt.y, endPt1.x, endPt1.y, endPt2.x, endPt2.y);
          if (res > 0) return -1;
          if (res < 0) return 1;
          return 0;
        };
        const length = (v) => Math.sqrt(dotProduct(v, v));
        const sineOfAngle = (pShared, pBase, pAngle) => {
          const vBase = {
            x: pBase.x - pShared.x,
            y: pBase.y - pShared.y
          };
          const vAngle = {
            x: pAngle.x - pShared.x,
            y: pAngle.y - pShared.y
          };
          return crossProduct(vAngle, vBase) / length(vAngle) / length(vBase);
        };
        const cosineOfAngle = (pShared, pBase, pAngle) => {
          const vBase = {
            x: pBase.x - pShared.x,
            y: pBase.y - pShared.y
          };
          const vAngle = {
            x: pAngle.x - pShared.x,
            y: pAngle.y - pShared.y
          };
          return dotProduct(vAngle, vBase) / length(vAngle) / length(vBase);
        };
        const horizontalIntersection = (pt, v, y) => {
          if (v.y === 0) return null;
          return {
            x: pt.x + v.x / v.y * (y - pt.y),
            y
          };
        };
        const verticalIntersection = (pt, v, x) => {
          if (v.x === 0) return null;
          return {
            x,
            y: pt.y + v.y / v.x * (x - pt.x)
          };
        };
        const intersection$1 = (pt1, v1, pt2, v2) => {
          if (v1.x === 0) return verticalIntersection(pt2, v2, pt1.x);
          if (v2.x === 0) return verticalIntersection(pt1, v1, pt2.x);
          if (v1.y === 0) return horizontalIntersection(pt2, v2, pt1.y);
          if (v2.y === 0) return horizontalIntersection(pt1, v1, pt2.y);
          const kross = crossProduct(v1, v2);
          if (kross == 0) return null;
          const ve = {
            x: pt2.x - pt1.x,
            y: pt2.y - pt1.y
          };
          const d1 = crossProduct(ve, v1) / kross;
          const d2 = crossProduct(ve, v2) / kross;
          const x1 = pt1.x + d2 * v1.x, x2 = pt2.x + d1 * v2.x;
          const y1 = pt1.y + d2 * v1.y, y2 = pt2.y + d1 * v2.y;
          const x = (x1 + x2) / 2;
          const y = (y1 + y2) / 2;
          return {
            x,
            y
          };
        };
        class SweepEvent {
          // for ordering sweep events in the sweep event queue
          static compare(a, b) {
            const ptCmp = SweepEvent.comparePoints(a.point, b.point);
            if (ptCmp !== 0) return ptCmp;
            if (a.point !== b.point) a.link(b);
            if (a.isLeft !== b.isLeft) return a.isLeft ? 1 : -1;
            return Segment.compare(a.segment, b.segment);
          }
          // for ordering points in sweep line order
          static comparePoints(aPt, bPt) {
            if (aPt.x < bPt.x) return -1;
            if (aPt.x > bPt.x) return 1;
            if (aPt.y < bPt.y) return -1;
            if (aPt.y > bPt.y) return 1;
            return 0;
          }
          // Warning: 'point' input will be modified and re-used (for performance)
          constructor(point, isLeft) {
            if (point.events === void 0) point.events = [this];
            else point.events.push(this);
            this.point = point;
            this.isLeft = isLeft;
          }
          link(other) {
            if (other.point === this.point) {
              throw new Error("Tried to link already linked events");
            }
            const otherEvents = other.point.events;
            for (let i = 0, iMax = otherEvents.length; i < iMax; i++) {
              const evt = otherEvents[i];
              this.point.events.push(evt);
              evt.point = this.point;
            }
            this.checkForConsuming();
          }
          /* Do a pass over our linked events and check to see if any pair
           * of segments match, and should be consumed. */
          checkForConsuming() {
            const numEvents = this.point.events.length;
            for (let i = 0; i < numEvents; i++) {
              const evt1 = this.point.events[i];
              if (evt1.segment.consumedBy !== void 0) continue;
              for (let j = i + 1; j < numEvents; j++) {
                const evt2 = this.point.events[j];
                if (evt2.consumedBy !== void 0) continue;
                if (evt1.otherSE.point.events !== evt2.otherSE.point.events) continue;
                evt1.segment.consume(evt2.segment);
              }
            }
          }
          getAvailableLinkedEvents() {
            const events = [];
            for (let i = 0, iMax = this.point.events.length; i < iMax; i++) {
              const evt = this.point.events[i];
              if (evt !== this && !evt.segment.ringOut && evt.segment.isInResult()) {
                events.push(evt);
              }
            }
            return events;
          }
          /**
           * Returns a comparator function for sorting linked events that will
           * favor the event that will give us the smallest left-side angle.
           * All ring construction starts as low as possible heading to the right,
           * so by always turning left as sharp as possible we'll get polygons
           * without uncessary loops & holes.
           *
           * The comparator function has a compute cache such that it avoids
           * re-computing already-computed values.
           */
          getLeftmostComparator(baseEvent) {
            const cache = /* @__PURE__ */ new Map();
            const fillCache = (linkedEvent) => {
              const nextEvent = linkedEvent.otherSE;
              cache.set(linkedEvent, {
                sine: sineOfAngle(this.point, baseEvent.point, nextEvent.point),
                cosine: cosineOfAngle(this.point, baseEvent.point, nextEvent.point)
              });
            };
            return (a, b) => {
              if (!cache.has(a)) fillCache(a);
              if (!cache.has(b)) fillCache(b);
              const {
                sine: asine,
                cosine: acosine
              } = cache.get(a);
              const {
                sine: bsine,
                cosine: bcosine
              } = cache.get(b);
              if (asine >= 0 && bsine >= 0) {
                if (acosine < bcosine) return 1;
                if (acosine > bcosine) return -1;
                return 0;
              }
              if (asine < 0 && bsine < 0) {
                if (acosine < bcosine) return -1;
                if (acosine > bcosine) return 1;
                return 0;
              }
              if (bsine < asine) return -1;
              if (bsine > asine) return 1;
              return 0;
            };
          }
        }
        let segmentId = 0;
        class Segment {
          /* This compare() function is for ordering segments in the sweep
           * line tree, and does so according to the following criteria:
           *
           * Consider the vertical line that lies an infinestimal step to the
           * right of the right-more of the two left endpoints of the input
           * segments. Imagine slowly moving a point up from negative infinity
           * in the increasing y direction. Which of the two segments will that
           * point intersect first? That segment comes 'before' the other one.
           *
           * If neither segment would be intersected by such a line, (if one
           * or more of the segments are vertical) then the line to be considered
           * is directly on the right-more of the two left inputs.
           */
          static compare(a, b) {
            const alx = a.leftSE.point.x;
            const blx = b.leftSE.point.x;
            const arx = a.rightSE.point.x;
            const brx = b.rightSE.point.x;
            if (brx < alx) return 1;
            if (arx < blx) return -1;
            const aly = a.leftSE.point.y;
            const bly = b.leftSE.point.y;
            const ary = a.rightSE.point.y;
            const bry = b.rightSE.point.y;
            if (alx < blx) {
              if (bly < aly && bly < ary) return 1;
              if (bly > aly && bly > ary) return -1;
              const aCmpBLeft = a.comparePoint(b.leftSE.point);
              if (aCmpBLeft < 0) return 1;
              if (aCmpBLeft > 0) return -1;
              const bCmpARight = b.comparePoint(a.rightSE.point);
              if (bCmpARight !== 0) return bCmpARight;
              return -1;
            }
            if (alx > blx) {
              if (aly < bly && aly < bry) return -1;
              if (aly > bly && aly > bry) return 1;
              const bCmpALeft = b.comparePoint(a.leftSE.point);
              if (bCmpALeft !== 0) return bCmpALeft;
              const aCmpBRight = a.comparePoint(b.rightSE.point);
              if (aCmpBRight < 0) return 1;
              if (aCmpBRight > 0) return -1;
              return 1;
            }
            if (aly < bly) return -1;
            if (aly > bly) return 1;
            if (arx < brx) {
              const bCmpARight = b.comparePoint(a.rightSE.point);
              if (bCmpARight !== 0) return bCmpARight;
            }
            if (arx > brx) {
              const aCmpBRight = a.comparePoint(b.rightSE.point);
              if (aCmpBRight < 0) return 1;
              if (aCmpBRight > 0) return -1;
            }
            if (arx !== brx) {
              const ay = ary - aly;
              const ax = arx - alx;
              const by = bry - bly;
              const bx = brx - blx;
              if (ay > ax && by < bx) return 1;
              if (ay < ax && by > bx) return -1;
            }
            if (arx > brx) return 1;
            if (arx < brx) return -1;
            if (ary < bry) return -1;
            if (ary > bry) return 1;
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
          }
          /* Warning: a reference to ringWindings input will be stored,
           *  and possibly will be later modified */
          constructor(leftSE, rightSE, rings, windings) {
            this.id = ++segmentId;
            this.leftSE = leftSE;
            leftSE.segment = this;
            leftSE.otherSE = rightSE;
            this.rightSE = rightSE;
            rightSE.segment = this;
            rightSE.otherSE = leftSE;
            this.rings = rings;
            this.windings = windings;
          }
          static fromRing(pt1, pt2, ring) {
            let leftPt, rightPt, winding;
            const cmpPts = SweepEvent.comparePoints(pt1, pt2);
            if (cmpPts < 0) {
              leftPt = pt1;
              rightPt = pt2;
              winding = 1;
            } else if (cmpPts > 0) {
              leftPt = pt2;
              rightPt = pt1;
              winding = -1;
            } else throw new Error(`Tried to create degenerate segment at [${pt1.x}, ${pt1.y}]`);
            const leftSE = new SweepEvent(leftPt, true);
            const rightSE = new SweepEvent(rightPt, false);
            return new Segment(leftSE, rightSE, [ring], [winding]);
          }
          /* When a segment is split, the rightSE is replaced with a new sweep event */
          replaceRightSE(newRightSE) {
            this.rightSE = newRightSE;
            this.rightSE.segment = this;
            this.rightSE.otherSE = this.leftSE;
            this.leftSE.otherSE = this.rightSE;
          }
          bbox() {
            const y1 = this.leftSE.point.y;
            const y2 = this.rightSE.point.y;
            return {
              ll: {
                x: this.leftSE.point.x,
                y: y1 < y2 ? y1 : y2
              },
              ur: {
                x: this.rightSE.point.x,
                y: y1 > y2 ? y1 : y2
              }
            };
          }
          /* A vector from the left point to the right */
          vector() {
            return {
              x: this.rightSE.point.x - this.leftSE.point.x,
              y: this.rightSE.point.y - this.leftSE.point.y
            };
          }
          isAnEndpoint(pt) {
            return pt.x === this.leftSE.point.x && pt.y === this.leftSE.point.y || pt.x === this.rightSE.point.x && pt.y === this.rightSE.point.y;
          }
          /* Compare this segment with a point.
           *
           * A point P is considered to be colinear to a segment if there
           * exists a distance D such that if we travel along the segment
           * from one * endpoint towards the other a distance D, we find
           * ourselves at point P.
           *
           * Return value indicates:
           *
           *   1: point lies above the segment (to the left of vertical)
           *   0: point is colinear to segment
           *  -1: point lies below the segment (to the right of vertical)
           */
          comparePoint(point) {
            if (this.isAnEndpoint(point)) return 0;
            const lPt = this.leftSE.point;
            const rPt = this.rightSE.point;
            const v = this.vector();
            if (lPt.x === rPt.x) {
              if (point.x === lPt.x) return 0;
              return point.x < lPt.x ? 1 : -1;
            }
            const yDist = (point.y - lPt.y) / v.y;
            const xFromYDist = lPt.x + yDist * v.x;
            if (point.x === xFromYDist) return 0;
            const xDist = (point.x - lPt.x) / v.x;
            const yFromXDist = lPt.y + xDist * v.y;
            if (point.y === yFromXDist) return 0;
            return point.y < yFromXDist ? -1 : 1;
          }
          /**
           * Given another segment, returns the first non-trivial intersection
           * between the two segments (in terms of sweep line ordering), if it exists.
           *
           * A 'non-trivial' intersection is one that will cause one or both of the
           * segments to be split(). As such, 'trivial' vs. 'non-trivial' intersection:
           *
           *   * endpoint of segA with endpoint of segB --> trivial
           *   * endpoint of segA with point along segB --> non-trivial
           *   * endpoint of segB with point along segA --> non-trivial
           *   * point along segA with point along segB --> non-trivial
           *
           * If no non-trivial intersection exists, return null
           * Else, return null.
           */
          getIntersection(other) {
            const tBbox = this.bbox();
            const oBbox = other.bbox();
            const bboxOverlap = getBboxOverlap(tBbox, oBbox);
            if (bboxOverlap === null) return null;
            const tlp = this.leftSE.point;
            const trp = this.rightSE.point;
            const olp = other.leftSE.point;
            const orp = other.rightSE.point;
            const touchesOtherLSE = isInBbox(tBbox, olp) && this.comparePoint(olp) === 0;
            const touchesThisLSE = isInBbox(oBbox, tlp) && other.comparePoint(tlp) === 0;
            const touchesOtherRSE = isInBbox(tBbox, orp) && this.comparePoint(orp) === 0;
            const touchesThisRSE = isInBbox(oBbox, trp) && other.comparePoint(trp) === 0;
            if (touchesThisLSE && touchesOtherLSE) {
              if (touchesThisRSE && !touchesOtherRSE) return trp;
              if (!touchesThisRSE && touchesOtherRSE) return orp;
              return null;
            }
            if (touchesThisLSE) {
              if (touchesOtherRSE) {
                if (tlp.x === orp.x && tlp.y === orp.y) return null;
              }
              return tlp;
            }
            if (touchesOtherLSE) {
              if (touchesThisRSE) {
                if (trp.x === olp.x && trp.y === olp.y) return null;
              }
              return olp;
            }
            if (touchesThisRSE && touchesOtherRSE) return null;
            if (touchesThisRSE) return trp;
            if (touchesOtherRSE) return orp;
            const pt = intersection$1(tlp, this.vector(), olp, other.vector());
            if (pt === null) return null;
            if (!isInBbox(bboxOverlap, pt)) return null;
            return rounder.round(pt.x, pt.y);
          }
          /**
           * Split the given segment into multiple segments on the given points.
           *  * Each existing segment will retain its leftSE and a new rightSE will be
           *    generated for it.
           *  * A new segment will be generated which will adopt the original segment's
           *    rightSE, and a new leftSE will be generated for it.
           *  * If there are more than two points given to split on, new segments
           *    in the middle will be generated with new leftSE and rightSE's.
           *  * An array of the newly generated SweepEvents will be returned.
           *
           * Warning: input array of points is modified
           */
          split(point) {
            const newEvents = [];
            const alreadyLinked = point.events !== void 0;
            const newLeftSE = new SweepEvent(point, true);
            const newRightSE = new SweepEvent(point, false);
            const oldRightSE = this.rightSE;
            this.replaceRightSE(newRightSE);
            newEvents.push(newRightSE);
            newEvents.push(newLeftSE);
            const newSeg = new Segment(newLeftSE, oldRightSE, this.rings.slice(), this.windings.slice());
            if (SweepEvent.comparePoints(newSeg.leftSE.point, newSeg.rightSE.point) > 0) {
              newSeg.swapEvents();
            }
            if (SweepEvent.comparePoints(this.leftSE.point, this.rightSE.point) > 0) {
              this.swapEvents();
            }
            if (alreadyLinked) {
              newLeftSE.checkForConsuming();
              newRightSE.checkForConsuming();
            }
            return newEvents;
          }
          /* Swap which event is left and right */
          swapEvents() {
            const tmpEvt = this.rightSE;
            this.rightSE = this.leftSE;
            this.leftSE = tmpEvt;
            this.leftSE.isLeft = true;
            this.rightSE.isLeft = false;
            for (let i = 0, iMax = this.windings.length; i < iMax; i++) {
              this.windings[i] *= -1;
            }
          }
          /* Consume another segment. We take their rings under our wing
           * and mark them as consumed. Use for perfectly overlapping segments */
          consume(other) {
            let consumer = this;
            let consumee = other;
            while (consumer.consumedBy) consumer = consumer.consumedBy;
            while (consumee.consumedBy) consumee = consumee.consumedBy;
            const cmp2 = Segment.compare(consumer, consumee);
            if (cmp2 === 0) return;
            if (cmp2 > 0) {
              const tmp = consumer;
              consumer = consumee;
              consumee = tmp;
            }
            if (consumer.prev === consumee) {
              const tmp = consumer;
              consumer = consumee;
              consumee = tmp;
            }
            for (let i = 0, iMax = consumee.rings.length; i < iMax; i++) {
              const ring = consumee.rings[i];
              const winding = consumee.windings[i];
              const index2 = consumer.rings.indexOf(ring);
              if (index2 === -1) {
                consumer.rings.push(ring);
                consumer.windings.push(winding);
              } else consumer.windings[index2] += winding;
            }
            consumee.rings = null;
            consumee.windings = null;
            consumee.consumedBy = consumer;
            consumee.leftSE.consumedBy = consumer.leftSE;
            consumee.rightSE.consumedBy = consumer.rightSE;
          }
          /* The first segment previous segment chain that is in the result */
          prevInResult() {
            if (this._prevInResult !== void 0) return this._prevInResult;
            if (!this.prev) this._prevInResult = null;
            else if (this.prev.isInResult()) this._prevInResult = this.prev;
            else this._prevInResult = this.prev.prevInResult();
            return this._prevInResult;
          }
          beforeState() {
            if (this._beforeState !== void 0) return this._beforeState;
            if (!this.prev) this._beforeState = {
              rings: [],
              windings: [],
              multiPolys: []
            };
            else {
              const seg = this.prev.consumedBy || this.prev;
              this._beforeState = seg.afterState();
            }
            return this._beforeState;
          }
          afterState() {
            if (this._afterState !== void 0) return this._afterState;
            const beforeState = this.beforeState();
            this._afterState = {
              rings: beforeState.rings.slice(0),
              windings: beforeState.windings.slice(0),
              multiPolys: []
            };
            const ringsAfter = this._afterState.rings;
            const windingsAfter = this._afterState.windings;
            const mpsAfter = this._afterState.multiPolys;
            for (let i = 0, iMax = this.rings.length; i < iMax; i++) {
              const ring = this.rings[i];
              const winding = this.windings[i];
              const index2 = ringsAfter.indexOf(ring);
              if (index2 === -1) {
                ringsAfter.push(ring);
                windingsAfter.push(winding);
              } else windingsAfter[index2] += winding;
            }
            const polysAfter = [];
            const polysExclude = [];
            for (let i = 0, iMax = ringsAfter.length; i < iMax; i++) {
              if (windingsAfter[i] === 0) continue;
              const ring = ringsAfter[i];
              const poly = ring.poly;
              if (polysExclude.indexOf(poly) !== -1) continue;
              if (ring.isExterior) polysAfter.push(poly);
              else {
                if (polysExclude.indexOf(poly) === -1) polysExclude.push(poly);
                const index2 = polysAfter.indexOf(ring.poly);
                if (index2 !== -1) polysAfter.splice(index2, 1);
              }
            }
            for (let i = 0, iMax = polysAfter.length; i < iMax; i++) {
              const mp = polysAfter[i].multiPoly;
              if (mpsAfter.indexOf(mp) === -1) mpsAfter.push(mp);
            }
            return this._afterState;
          }
          /* Is this segment part of the final result? */
          isInResult() {
            if (this.consumedBy) return false;
            if (this._isInResult !== void 0) return this._isInResult;
            const mpsBefore = this.beforeState().multiPolys;
            const mpsAfter = this.afterState().multiPolys;
            switch (operation.type) {
              case "union": {
                const noBefores = mpsBefore.length === 0;
                const noAfters = mpsAfter.length === 0;
                this._isInResult = noBefores !== noAfters;
                break;
              }
              case "intersection": {
                let least;
                let most;
                if (mpsBefore.length < mpsAfter.length) {
                  least = mpsBefore.length;
                  most = mpsAfter.length;
                } else {
                  least = mpsAfter.length;
                  most = mpsBefore.length;
                }
                this._isInResult = most === operation.numMultiPolys && least < most;
                break;
              }
              case "xor": {
                const diff = Math.abs(mpsBefore.length - mpsAfter.length);
                this._isInResult = diff % 2 === 1;
                break;
              }
              case "difference": {
                const isJustSubject = (mps) => mps.length === 1 && mps[0].isSubject;
                this._isInResult = isJustSubject(mpsBefore) !== isJustSubject(mpsAfter);
                break;
              }
              default:
                throw new Error(`Unrecognized operation type found ${operation.type}`);
            }
            return this._isInResult;
          }
        }
        class RingIn {
          constructor(geomRing, poly, isExterior) {
            if (!Array.isArray(geomRing) || geomRing.length === 0) {
              throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
            }
            this.poly = poly;
            this.isExterior = isExterior;
            this.segments = [];
            if (typeof geomRing[0][0] !== "number" || typeof geomRing[0][1] !== "number") {
              throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
            }
            const firstPoint = rounder.round(geomRing[0][0], geomRing[0][1]);
            this.bbox = {
              ll: {
                x: firstPoint.x,
                y: firstPoint.y
              },
              ur: {
                x: firstPoint.x,
                y: firstPoint.y
              }
            };
            let prevPoint = firstPoint;
            for (let i = 1, iMax = geomRing.length; i < iMax; i++) {
              if (typeof geomRing[i][0] !== "number" || typeof geomRing[i][1] !== "number") {
                throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
              }
              let point = rounder.round(geomRing[i][0], geomRing[i][1]);
              if (point.x === prevPoint.x && point.y === prevPoint.y) continue;
              this.segments.push(Segment.fromRing(prevPoint, point, this));
              if (point.x < this.bbox.ll.x) this.bbox.ll.x = point.x;
              if (point.y < this.bbox.ll.y) this.bbox.ll.y = point.y;
              if (point.x > this.bbox.ur.x) this.bbox.ur.x = point.x;
              if (point.y > this.bbox.ur.y) this.bbox.ur.y = point.y;
              prevPoint = point;
            }
            if (firstPoint.x !== prevPoint.x || firstPoint.y !== prevPoint.y) {
              this.segments.push(Segment.fromRing(prevPoint, firstPoint, this));
            }
          }
          getSweepEvents() {
            const sweepEvents = [];
            for (let i = 0, iMax = this.segments.length; i < iMax; i++) {
              const segment = this.segments[i];
              sweepEvents.push(segment.leftSE);
              sweepEvents.push(segment.rightSE);
            }
            return sweepEvents;
          }
        }
        class PolyIn {
          constructor(geomPoly, multiPoly) {
            if (!Array.isArray(geomPoly)) {
              throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
            }
            this.exteriorRing = new RingIn(geomPoly[0], this, true);
            this.bbox = {
              ll: {
                x: this.exteriorRing.bbox.ll.x,
                y: this.exteriorRing.bbox.ll.y
              },
              ur: {
                x: this.exteriorRing.bbox.ur.x,
                y: this.exteriorRing.bbox.ur.y
              }
            };
            this.interiorRings = [];
            for (let i = 1, iMax = geomPoly.length; i < iMax; i++) {
              const ring = new RingIn(geomPoly[i], this, false);
              if (ring.bbox.ll.x < this.bbox.ll.x) this.bbox.ll.x = ring.bbox.ll.x;
              if (ring.bbox.ll.y < this.bbox.ll.y) this.bbox.ll.y = ring.bbox.ll.y;
              if (ring.bbox.ur.x > this.bbox.ur.x) this.bbox.ur.x = ring.bbox.ur.x;
              if (ring.bbox.ur.y > this.bbox.ur.y) this.bbox.ur.y = ring.bbox.ur.y;
              this.interiorRings.push(ring);
            }
            this.multiPoly = multiPoly;
          }
          getSweepEvents() {
            const sweepEvents = this.exteriorRing.getSweepEvents();
            for (let i = 0, iMax = this.interiorRings.length; i < iMax; i++) {
              const ringSweepEvents = this.interiorRings[i].getSweepEvents();
              for (let j = 0, jMax = ringSweepEvents.length; j < jMax; j++) {
                sweepEvents.push(ringSweepEvents[j]);
              }
            }
            return sweepEvents;
          }
        }
        class MultiPolyIn {
          constructor(geom, isSubject) {
            if (!Array.isArray(geom)) {
              throw new Error("Input geometry is not a valid Polygon or MultiPolygon");
            }
            try {
              if (typeof geom[0][0][0] === "number") geom = [geom];
            } catch (ex) {
            }
            this.polys = [];
            this.bbox = {
              ll: {
                x: Number.POSITIVE_INFINITY,
                y: Number.POSITIVE_INFINITY
              },
              ur: {
                x: Number.NEGATIVE_INFINITY,
                y: Number.NEGATIVE_INFINITY
              }
            };
            for (let i = 0, iMax = geom.length; i < iMax; i++) {
              const poly = new PolyIn(geom[i], this);
              if (poly.bbox.ll.x < this.bbox.ll.x) this.bbox.ll.x = poly.bbox.ll.x;
              if (poly.bbox.ll.y < this.bbox.ll.y) this.bbox.ll.y = poly.bbox.ll.y;
              if (poly.bbox.ur.x > this.bbox.ur.x) this.bbox.ur.x = poly.bbox.ur.x;
              if (poly.bbox.ur.y > this.bbox.ur.y) this.bbox.ur.y = poly.bbox.ur.y;
              this.polys.push(poly);
            }
            this.isSubject = isSubject;
          }
          getSweepEvents() {
            const sweepEvents = [];
            for (let i = 0, iMax = this.polys.length; i < iMax; i++) {
              const polySweepEvents = this.polys[i].getSweepEvents();
              for (let j = 0, jMax = polySweepEvents.length; j < jMax; j++) {
                sweepEvents.push(polySweepEvents[j]);
              }
            }
            return sweepEvents;
          }
        }
        class RingOut {
          /* Given the segments from the sweep line pass, compute & return a series
           * of closed rings from all the segments marked to be part of the result */
          static factory(allSegments) {
            const ringsOut = [];
            for (let i = 0, iMax = allSegments.length; i < iMax; i++) {
              const segment = allSegments[i];
              if (!segment.isInResult() || segment.ringOut) continue;
              let prevEvent = null;
              let event = segment.leftSE;
              let nextEvent = segment.rightSE;
              const events = [event];
              const startingPoint = event.point;
              const intersectionLEs = [];
              while (true) {
                prevEvent = event;
                event = nextEvent;
                events.push(event);
                if (event.point === startingPoint) break;
                while (true) {
                  const availableLEs = event.getAvailableLinkedEvents();
                  if (availableLEs.length === 0) {
                    const firstPt = events[0].point;
                    const lastPt = events[events.length - 1].point;
                    throw new Error(`Unable to complete output ring starting at [${firstPt.x}, ${firstPt.y}]. Last matching segment found ends at [${lastPt.x}, ${lastPt.y}].`);
                  }
                  if (availableLEs.length === 1) {
                    nextEvent = availableLEs[0].otherSE;
                    break;
                  }
                  let indexLE = null;
                  for (let j = 0, jMax = intersectionLEs.length; j < jMax; j++) {
                    if (intersectionLEs[j].point === event.point) {
                      indexLE = j;
                      break;
                    }
                  }
                  if (indexLE !== null) {
                    const intersectionLE = intersectionLEs.splice(indexLE)[0];
                    const ringEvents = events.splice(intersectionLE.index);
                    ringEvents.unshift(ringEvents[0].otherSE);
                    ringsOut.push(new RingOut(ringEvents.reverse()));
                    continue;
                  }
                  intersectionLEs.push({
                    index: events.length,
                    point: event.point
                  });
                  const comparator = event.getLeftmostComparator(prevEvent);
                  nextEvent = availableLEs.sort(comparator)[0].otherSE;
                  break;
                }
              }
              ringsOut.push(new RingOut(events));
            }
            return ringsOut;
          }
          constructor(events) {
            this.events = events;
            for (let i = 0, iMax = events.length; i < iMax; i++) {
              events[i].segment.ringOut = this;
            }
            this.poly = null;
          }
          getGeom() {
            let prevPt = this.events[0].point;
            const points = [prevPt];
            for (let i = 1, iMax = this.events.length - 1; i < iMax; i++) {
              const pt2 = this.events[i].point;
              const nextPt2 = this.events[i + 1].point;
              if (compareVectorAngles(pt2, prevPt, nextPt2) === 0) continue;
              points.push(pt2);
              prevPt = pt2;
            }
            if (points.length === 1) return null;
            const pt = points[0];
            const nextPt = points[1];
            if (compareVectorAngles(pt, prevPt, nextPt) === 0) points.shift();
            points.push(points[0]);
            const step = this.isExteriorRing() ? 1 : -1;
            const iStart = this.isExteriorRing() ? 0 : points.length - 1;
            const iEnd = this.isExteriorRing() ? points.length : -1;
            const orderedPoints = [];
            for (let i = iStart; i != iEnd; i += step) orderedPoints.push([points[i].x, points[i].y]);
            return orderedPoints;
          }
          isExteriorRing() {
            if (this._isExteriorRing === void 0) {
              const enclosing = this.enclosingRing();
              this._isExteriorRing = enclosing ? !enclosing.isExteriorRing() : true;
            }
            return this._isExteriorRing;
          }
          enclosingRing() {
            if (this._enclosingRing === void 0) {
              this._enclosingRing = this._calcEnclosingRing();
            }
            return this._enclosingRing;
          }
          /* Returns the ring that encloses this one, if any */
          _calcEnclosingRing() {
            let leftMostEvt = this.events[0];
            for (let i = 1, iMax = this.events.length; i < iMax; i++) {
              const evt = this.events[i];
              if (SweepEvent.compare(leftMostEvt, evt) > 0) leftMostEvt = evt;
            }
            let prevSeg = leftMostEvt.segment.prevInResult();
            let prevPrevSeg = prevSeg ? prevSeg.prevInResult() : null;
            while (true) {
              if (!prevSeg) return null;
              if (!prevPrevSeg) return prevSeg.ringOut;
              if (prevPrevSeg.ringOut !== prevSeg.ringOut) {
                if (prevPrevSeg.ringOut.enclosingRing() !== prevSeg.ringOut) {
                  return prevSeg.ringOut;
                } else return prevSeg.ringOut.enclosingRing();
              }
              prevSeg = prevPrevSeg.prevInResult();
              prevPrevSeg = prevSeg ? prevSeg.prevInResult() : null;
            }
          }
        }
        class PolyOut {
          constructor(exteriorRing) {
            this.exteriorRing = exteriorRing;
            exteriorRing.poly = this;
            this.interiorRings = [];
          }
          addInterior(ring) {
            this.interiorRings.push(ring);
            ring.poly = this;
          }
          getGeom() {
            const geom = [this.exteriorRing.getGeom()];
            if (geom[0] === null) return null;
            for (let i = 0, iMax = this.interiorRings.length; i < iMax; i++) {
              const ringGeom = this.interiorRings[i].getGeom();
              if (ringGeom === null) continue;
              geom.push(ringGeom);
            }
            return geom;
          }
        }
        class MultiPolyOut {
          constructor(rings) {
            this.rings = rings;
            this.polys = this._composePolys(rings);
          }
          getGeom() {
            const geom = [];
            for (let i = 0, iMax = this.polys.length; i < iMax; i++) {
              const polyGeom = this.polys[i].getGeom();
              if (polyGeom === null) continue;
              geom.push(polyGeom);
            }
            return geom;
          }
          _composePolys(rings) {
            const polys = [];
            for (let i = 0, iMax = rings.length; i < iMax; i++) {
              const ring = rings[i];
              if (ring.poly) continue;
              if (ring.isExteriorRing()) polys.push(new PolyOut(ring));
              else {
                const enclosingRing = ring.enclosingRing();
                if (!enclosingRing.poly) polys.push(new PolyOut(enclosingRing));
                enclosingRing.poly.addInterior(ring);
              }
            }
            return polys;
          }
        }
        class SweepLine {
          constructor(queue) {
            let comparator = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : Segment.compare;
            this.queue = queue;
            this.tree = new Tree(comparator);
            this.segments = [];
          }
          process(event) {
            const segment = event.segment;
            const newEvents = [];
            if (event.consumedBy) {
              if (event.isLeft) this.queue.remove(event.otherSE);
              else this.tree.remove(segment);
              return newEvents;
            }
            const node = event.isLeft ? this.tree.add(segment) : this.tree.find(segment);
            if (!node) throw new Error(`Unable to find segment #${segment.id} [${segment.leftSE.point.x}, ${segment.leftSE.point.y}] -> [${segment.rightSE.point.x}, ${segment.rightSE.point.y}] in SweepLine tree.`);
            let prevNode = node;
            let nextNode = node;
            let prevSeg = void 0;
            let nextSeg = void 0;
            while (prevSeg === void 0) {
              prevNode = this.tree.prev(prevNode);
              if (prevNode === null) prevSeg = null;
              else if (prevNode.key.consumedBy === void 0) prevSeg = prevNode.key;
            }
            while (nextSeg === void 0) {
              nextNode = this.tree.next(nextNode);
              if (nextNode === null) nextSeg = null;
              else if (nextNode.key.consumedBy === void 0) nextSeg = nextNode.key;
            }
            if (event.isLeft) {
              let prevMySplitter = null;
              if (prevSeg) {
                const prevInter = prevSeg.getIntersection(segment);
                if (prevInter !== null) {
                  if (!segment.isAnEndpoint(prevInter)) prevMySplitter = prevInter;
                  if (!prevSeg.isAnEndpoint(prevInter)) {
                    const newEventsFromSplit = this._splitSafely(prevSeg, prevInter);
                    for (let i = 0, iMax = newEventsFromSplit.length; i < iMax; i++) {
                      newEvents.push(newEventsFromSplit[i]);
                    }
                  }
                }
              }
              let nextMySplitter = null;
              if (nextSeg) {
                const nextInter = nextSeg.getIntersection(segment);
                if (nextInter !== null) {
                  if (!segment.isAnEndpoint(nextInter)) nextMySplitter = nextInter;
                  if (!nextSeg.isAnEndpoint(nextInter)) {
                    const newEventsFromSplit = this._splitSafely(nextSeg, nextInter);
                    for (let i = 0, iMax = newEventsFromSplit.length; i < iMax; i++) {
                      newEvents.push(newEventsFromSplit[i]);
                    }
                  }
                }
              }
              if (prevMySplitter !== null || nextMySplitter !== null) {
                let mySplitter = null;
                if (prevMySplitter === null) mySplitter = nextMySplitter;
                else if (nextMySplitter === null) mySplitter = prevMySplitter;
                else {
                  const cmpSplitters = SweepEvent.comparePoints(prevMySplitter, nextMySplitter);
                  mySplitter = cmpSplitters <= 0 ? prevMySplitter : nextMySplitter;
                }
                this.queue.remove(segment.rightSE);
                newEvents.push(segment.rightSE);
                const newEventsFromSplit = segment.split(mySplitter);
                for (let i = 0, iMax = newEventsFromSplit.length; i < iMax; i++) {
                  newEvents.push(newEventsFromSplit[i]);
                }
              }
              if (newEvents.length > 0) {
                this.tree.remove(segment);
                newEvents.push(event);
              } else {
                this.segments.push(segment);
                segment.prev = prevSeg;
              }
            } else {
              if (prevSeg && nextSeg) {
                const inter = prevSeg.getIntersection(nextSeg);
                if (inter !== null) {
                  if (!prevSeg.isAnEndpoint(inter)) {
                    const newEventsFromSplit = this._splitSafely(prevSeg, inter);
                    for (let i = 0, iMax = newEventsFromSplit.length; i < iMax; i++) {
                      newEvents.push(newEventsFromSplit[i]);
                    }
                  }
                  if (!nextSeg.isAnEndpoint(inter)) {
                    const newEventsFromSplit = this._splitSafely(nextSeg, inter);
                    for (let i = 0, iMax = newEventsFromSplit.length; i < iMax; i++) {
                      newEvents.push(newEventsFromSplit[i]);
                    }
                  }
                }
              }
              this.tree.remove(segment);
            }
            return newEvents;
          }
          /* Safely split a segment that is currently in the datastructures
           * IE - a segment other than the one that is currently being processed. */
          _splitSafely(seg, pt) {
            this.tree.remove(seg);
            const rightSE = seg.rightSE;
            this.queue.remove(rightSE);
            const newEvents = seg.split(pt);
            newEvents.push(rightSE);
            if (seg.consumedBy === void 0) this.tree.add(seg);
            return newEvents;
          }
        }
        const POLYGON_CLIPPING_MAX_QUEUE_SIZE = typeof process !== "undefined" && process.env.POLYGON_CLIPPING_MAX_QUEUE_SIZE || 1e6;
        const POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS = typeof process !== "undefined" && process.env.POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS || 1e6;
        class Operation {
          run(type, geom, moreGeoms) {
            operation.type = type;
            rounder.reset();
            const multipolys = [new MultiPolyIn(geom, true)];
            for (let i = 0, iMax = moreGeoms.length; i < iMax; i++) {
              multipolys.push(new MultiPolyIn(moreGeoms[i], false));
            }
            operation.numMultiPolys = multipolys.length;
            if (operation.type === "difference") {
              const subject = multipolys[0];
              let i = 1;
              while (i < multipolys.length) {
                if (getBboxOverlap(multipolys[i].bbox, subject.bbox) !== null) i++;
                else multipolys.splice(i, 1);
              }
            }
            if (operation.type === "intersection") {
              for (let i = 0, iMax = multipolys.length; i < iMax; i++) {
                const mpA = multipolys[i];
                for (let j = i + 1, jMax = multipolys.length; j < jMax; j++) {
                  if (getBboxOverlap(mpA.bbox, multipolys[j].bbox) === null) return [];
                }
              }
            }
            const queue = new Tree(SweepEvent.compare);
            for (let i = 0, iMax = multipolys.length; i < iMax; i++) {
              const sweepEvents = multipolys[i].getSweepEvents();
              for (let j = 0, jMax = sweepEvents.length; j < jMax; j++) {
                queue.insert(sweepEvents[j]);
                if (queue.size > POLYGON_CLIPPING_MAX_QUEUE_SIZE) {
                  throw new Error("Infinite loop when putting segment endpoints in a priority queue (queue size too big).");
                }
              }
            }
            const sweepLine = new SweepLine(queue);
            let prevQueueSize = queue.size;
            let node = queue.pop();
            while (node) {
              const evt = node.key;
              if (queue.size === prevQueueSize) {
                const seg = evt.segment;
                throw new Error(`Unable to pop() ${evt.isLeft ? "left" : "right"} SweepEvent [${evt.point.x}, ${evt.point.y}] from segment #${seg.id} [${seg.leftSE.point.x}, ${seg.leftSE.point.y}] -> [${seg.rightSE.point.x}, ${seg.rightSE.point.y}] from queue.`);
              }
              if (queue.size > POLYGON_CLIPPING_MAX_QUEUE_SIZE) {
                throw new Error("Infinite loop when passing sweep line over endpoints (queue size too big).");
              }
              if (sweepLine.segments.length > POLYGON_CLIPPING_MAX_SWEEPLINE_SEGMENTS) {
                throw new Error("Infinite loop when passing sweep line over endpoints (too many sweep line segments).");
              }
              const newEvents = sweepLine.process(evt);
              for (let i = 0, iMax = newEvents.length; i < iMax; i++) {
                const evt2 = newEvents[i];
                if (evt2.consumedBy === void 0) queue.insert(evt2);
              }
              prevQueueSize = queue.size;
              node = queue.pop();
            }
            rounder.reset();
            const ringsOut = RingOut.factory(sweepLine.segments);
            const result = new MultiPolyOut(ringsOut);
            return result.getGeom();
          }
        }
        const operation = new Operation();
        const union2 = function(geom) {
          for (var _len = arguments.length, moreGeoms = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
            moreGeoms[_key - 1] = arguments[_key];
          }
          return operation.run("union", geom, moreGeoms);
        };
        const intersection = function(geom) {
          for (var _len2 = arguments.length, moreGeoms = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
            moreGeoms[_key2 - 1] = arguments[_key2];
          }
          return operation.run("intersection", geom, moreGeoms);
        };
        const xor = function(geom) {
          for (var _len3 = arguments.length, moreGeoms = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) {
            moreGeoms[_key3 - 1] = arguments[_key3];
          }
          return operation.run("xor", geom, moreGeoms);
        };
        const difference2 = function(subjectGeom) {
          for (var _len4 = arguments.length, clippingGeoms = new Array(_len4 > 1 ? _len4 - 1 : 0), _key4 = 1; _key4 < _len4; _key4++) {
            clippingGeoms[_key4 - 1] = arguments[_key4];
          }
          return operation.run("difference", subjectGeom, clippingGeoms);
        };
        var index = {
          union: union2,
          intersection,
          xor,
          difference: difference2
        };
        return index;
      });
    }
  });

  // iframe/polygon-clipping-entry.js
  var polygon_clipping_entry_exports = {};
  __export(polygon_clipping_entry_exports, {
    difference: () => import_polygon_clipping.difference,
    offsetRings: () => offsetRings,
    union: () => import_polygon_clipping.union
  });
  var import_clipper_lib = __toESM(require_clipper());
  var import_polygon_clipping = __toESM(require_polygon_clipping_umd());
  var OFFSET_SCALE = 1e3;
  function toClipperPath(ring) {
    return ring.map((point) => ({
      X: Math.round(Number(point[0]) * OFFSET_SCALE),
      Y: Math.round(Number(point[1]) * OFFSET_SCALE)
    }));
  }
  function fromClipperPath(path) {
    return path.map((point) => [
      point.X / OFFSET_SCALE,
      point.Y / OFFSET_SCALE
    ]);
  }
  function offsetRings(rings, amount) {
    if (!Array.isArray(rings) || rings.length === 0 || !Number.isFinite(amount) || amount <= 0) {
      return rings;
    }
    const paths = rings.filter((ring) => Array.isArray(ring) && ring.length >= 4).map(toClipperPath).filter((path) => path.length >= 4);
    if (paths.length === 0) {
      return [];
    }
    const offset = new import_clipper_lib.default.ClipperOffset(2, 0.25 * OFFSET_SCALE);
    offset.AddPaths(paths, import_clipper_lib.default.JoinType.jtMiter, import_clipper_lib.default.EndType.etClosedPolygon);
    const solution = new import_clipper_lib.default.Paths();
    offset.Execute(solution, amount * OFFSET_SCALE);
    return solution.map(fromClipperPath).filter((ring) => ring.length >= 3).map((ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (Math.abs(first[0] - last[0]) > 1e-3 || Math.abs(first[1] - last[1]) > 1e-3) {
        ring.push([first[0], first[1]]);
      }
      return ring;
    });
  }
  return __toCommonJS(polygon_clipping_entry_exports);
})();
/*! Bundled license information:

polygon-clipping/dist/polygon-clipping.umd.js:
  (**
   * splaytree v3.1.2
   * Fast Splay tree for Node and browser
   *
   * @author Alexander Milevski <info@w8r.name>
   * @license MIT
   * @preserve
   *)
  (*! *****************************************************************************
      Copyright (c) Microsoft Corporation. All rights reserved.
      Licensed under the Apache License, Version 2.0 (the "License"); you may not use
      this file except in compliance with the License. You may obtain a copy of the
      License at http://www.apache.org/licenses/LICENSE-2.0
  
      THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
      KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
      WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
      MERCHANTABLITY OR NON-INFRINGEMENT.
  
      See the Apache Version 2.0 License for specific language governing permissions
      and limitations under the License.
      ***************************************************************************** *)
*/

export default AutoCopperPolygonClipping;
