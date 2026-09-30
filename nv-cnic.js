/* NovaX CNIC photos (30 Sep 2026).
   One implementation for signup (index.html), the merchant Profile
   (client-app.js) and admin review (admin.html). Photos go to the private
   client-kyc bucket as <client_id>/cnic-<front|back>-<ms>-<8 hex>.jpg.
   Who may upload, see or delete them is decided by the database
   (sql_novax_client_cnic_20260930.sql + _hardening_), never by this file. */
(function () {
  "use strict";
  var BUCKET = "client-kyc";
  /* What the file inputs offer. Only formats every browser can open: an
     iPhone turns HEIC into JPEG by itself when HEIC is not on this list. */
  var ACCEPT = "image/jpeg,image/png,image/webp";
  var TYPES = /^image\/(jpe?g|pjpeg|png|webp|heic|heif|heic-sequence|heif-sequence)$/i;
  var MAX_EDGE = 1600;                     // long side after shrinking; text stays readable
  var MIN_LONG = 600, MIN_SHORT = 380;     // smaller than this cannot be read
  var MAX_RATIO = 2.5;                     // a strip, not a photo of a card (a CNIC is 1.59)
  var MAX_IN = 25 * 1024 * 1024, MAX_OUT = 2.8 * 1024 * 1024;   // bucket limit is 3 MB
  var GRID_W = 32, GRID_H = 20;            // tiny greyscale copy for the blank and dark checks

  function fail(msg) { return Promise.reject(new Error(msg)); }
  function isHeic(file) { return /hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || ""); }
  var HEIC_MSG = "This phone photo format (HEIC) can't be opened here. Take the photo with the camera option, or choose a JPG.";

  function sample(img) {
    try {
      var c = document.createElement("canvas"); c.width = GRID_W; c.height = GRID_H;
      var g = c.getContext("2d");
      if (!g || typeof g.getImageData !== "function") return null;
      g.drawImage(img, 0, 0, GRID_W, GRID_H);
      var d = g.getImageData(0, 0, GRID_W, GRID_H).data, lum = [], sum = 0, v = 0, i;
      for (i = 0; i + 2 < d.length; i += 4) { var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; lum.push(y); sum += y; }
      if (!lum.length) return null;
      var mean = sum / lum.length;
      for (i = 0; i < lum.length; i++) v += (lum[i] - mean) * (lum[i] - mean);
      return { mean: mean, sd: Math.sqrt(v / lum.length) };
    } catch (e) { return null; }
  }
  /* The same file chosen twice, by a fingerprint of its bytes. Comparing
     pictures instead was tried and dropped: a front and a back photographed
     small on the same table look alike in a small copy, and an honest
     merchant would be told "same photo". The database also refuses two
     uploads with the same checksum. */
  function digest(file) {
    try {
      if (!window.crypto || !window.crypto.subtle || typeof file.arrayBuffer !== "function") return Promise.resolve("");
      return file.arrayBuffer().then(function (buf) { return window.crypto.subtle.digest("SHA-256", buf); }).then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      }).catch(function () { return ""; });
    } catch (e) { return Promise.resolve(""); }
  }
  function sameShot(a, b) { return !!(a && b && a.hash && b.hash && a.hash === b.hash); }

  /* Shrink a phone photo to a JPEG of about 150 KB. Redrawing it also drops
     the hidden data phones store in photos (location, phone model). */
  function prepare(file) {
    if (!file) return fail("Choose a photo.");
    if (file.size > MAX_IN) return fail("That photo is too large. Take a new photo with your phone camera.");
    if (file.type && !TYPES.test(file.type)) return fail("Use a photo of the card: JPG or PNG.");
    return Promise.all([shrink(file), digest(file)]).then(function (r) { r[0].hash = r[1]; return r[0]; });
  }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w0 = img.naturalWidth, h0 = img.naturalHeight, long = Math.max(w0, h0), short = Math.min(w0, h0);
        var stop = function (msg) { URL.revokeObjectURL(url); reject(new Error(msg)); };
        if (long < MIN_LONG || short < MIN_SHORT) return stop("That photo is too small to read. Take a closer photo of the card.");
        if (long / short > MAX_RATIO) return stop("That picture is too long and narrow to read. Take a normal photo of the whole card.");
        var sig = sample(img);
        if (sig && sig.mean < 22) return stop("That photo is too dark to read. Take it again in good light.");
        if (sig && sig.sd < 6) return stop("That photo looks blank. Take a photo of the card in good light.");
        var k = Math.min(1, MAX_EDGE / long);
        var w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        var g = c.getContext("2d");
        if (!g) return stop("This browser cannot prepare photos. Try Chrome.");
        g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        (function encode(q) {
          c.toBlob(function (b) {
            if (!b) { reject(new Error("That photo could not be prepared. Try another photo.")); return; }
            if (b.size > MAX_OUT && q > 0.5) { encode(q - 0.15); return; }
            if (b.size > MAX_OUT) { reject(new Error("That photo is too large. Take a new photo with your phone camera.")); return; }
            resolve({ blob: b, width: w, height: h, preview: URL.createObjectURL(b), sig: sig });
          }, "image/jpeg", q);
        })(0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(isHeic(file) ? HEIC_MSG : "This photo can't be opened here. Take it with your phone camera, or use a JPG or PNG."));
      };
      img.src = url;
    });
  }

  function isUuid(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || "")); }
  function hex8() {
    try { var a = new Uint32Array(1); crypto.getRandomValues(a); return ("0000000" + a[0].toString(16)).slice(-8); }
    catch (e) { return ("0000000" + Math.floor(Math.random() * 4294967296).toString(16)).slice(-8); }
  }
  /* A random tail, so two uploads in the same millisecond never collide. */
  function paths(clientId) {
    var id = String(clientId).toLowerCase(), t = Date.now();
    return { front: id + "/cnic-front-" + t + "-" + hex8() + ".jpg", back: id + "/cnic-back-" + t + "-" + hex8() + ".jpg" };
  }
  function timeout(p, ms, msg) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error(msg)); } }, ms);
      Promise.resolve(p).then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                              function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }
  function data(r, fallback) {
    if (r && r.error) throw new Error(r.error.message || fallback);
    return r ? r.data : null;
  }
  /* Best effort: the database only lets a merchant remove uploads that were
     never submitted, so this can never delete a recorded photo. */
  function removeQuietly(sb, names) {
    names = (names || []).filter(Boolean);
    if (!names.length) return Promise.resolve();
    try { return Promise.resolve(sb.storage.from(BUCKET).remove(names)).then(function () {}, function () {}); }
    catch (e) { return Promise.resolve(); }
  }
  function putOne(sb, path, photo) {
    return Promise.resolve(sb.storage.from(BUCKET).upload(path, photo.blob || photo,
      { contentType: "image/jpeg", upsert: false, cacheControl: "60" }))
      .then(function (r) { data(r, "The photo did not upload."); return path; });
  }
  var SAVE_FAILED = "The photos could not be saved. Refresh the page and try again.";
  function check(sb) {
    return Promise.resolve(sb.rpc("client_kyc_upload_check")).then(function (r) {
      var d = data(r, "Could not check your account. Try again.");
      if (d && d.ok === false) throw new Error(d.message || "You can't add photos right now.");
    });
  }
  /* Both photos, or neither is left behind: whatever finished uploading is
     removed again when the other fails, or when it finishes after we gave up. */
  function upload(sb, clientId, front, back, ms, merchant) {
    if (!sb || !sb.storage || !sb.rpc) return fail("Not connected. Refresh the page and try again.");
    if (!isUuid(clientId)) return fail("Your account is still loading. Try again in a moment.");
    if (!front || !back) return fail("Add a photo of the front and the back of the CNIC.");
    if (sameShot(front, back)) return fail("The front and the back are the same photo. Add a photo of each side of the card.");
    var p = paths(clientId), finished = [], gaveUp = false;
    var one = function (path, photo) {
      return putOne(sb, path, photo).then(function (x) {
        finished.push(path);
        if (gaveUp) removeQuietly(sb, [path]);
        return x;
      });
    };
    return (merchant ? check(sb) : Promise.resolve()).then(function () {
      return timeout(Promise.all([one(p.front, front), one(p.back, back)]), ms || 90000,
        "The upload is taking too long. Check your connection and try again.");
    }).then(function () { return p; }, function (err) {
      gaveUp = true;
      removeQuietly(sb, finished.slice());
      /* A refused upload: ask the database why, in words the merchant can act on. */
      if (merchant && /row-level security|Unauthorized|403/i.test(String(err && err.message))) {
        return check(sb).then(function () { throw new Error(SAVE_FAILED); });
      }
      throw err;
    });
  }
  function record(sb, p, rpc, args) {
    return Promise.resolve(sb.rpc(rpc, args)).then(function (r) { return data(r, "The CNIC was not saved. Try again."); })
      .catch(function (err) { removeQuietly(sb, [p.front, p.back]); throw err; });
  }
  /* Merchant: upload, then record them for checking. */
  function send(sb, clientId, front, back, ms) {
    return upload(sb, clientId, front, back, ms, true).then(function (p) {
      return record(sb, p, "client_kyc_submit", { p_front: p.front, p_back: p.back });
    });
  }
  /* Admin: photos the merchant sent another way (WhatsApp, email). */
  function attach(sb, clientId, front, back) {
    return upload(sb, clientId, front, back, 90000, false).then(function (p) {
      return record(sb, p, "admin_kyc_attach", { p_client: clientId, p_front: p.front, p_back: p.back });
    });
  }
  function status(sb) {
    return Promise.resolve(sb.rpc("client_kyc_status")).then(function (r) { return data(r, "Could not load the CNIC."); });
  }
  /* Short-lived links; the bucket is private and never has public URLs. */
  function signedUrls(sb, list, seconds) {
    var names = (list || []).filter(Boolean);
    if (!names.length) return Promise.resolve({});
    return Promise.resolve(sb.storage.from(BUCKET).createSignedUrls(names, seconds || 300)).then(function (r) {
      var out = {};
      (data(r, "Could not open the photos.") || []).forEach(function (x) { if (x && x.path && x.signedUrl) out[x.path] = x.signedUrl; });
      return out;
    });
  }

  /* Two photo tiles: [data-cnic-side="front"|"back"], each holding an
     <input type=file>, an <img> and a [data-cnic-note]. */
  function picker(root, opts) {
    opts = opts || {};
    var photos = { front: null, back: null }, notes = {};
    function each(fn) { Array.prototype.forEach.call(root.querySelectorAll("[data-cnic-side]"), fn); }
    function changed(err) { if (opts.onChange) { try { opts.onChange(photos, err); } catch (e) {} } }
    function drop(side) { if (photos[side] && photos[side].preview) { try { URL.revokeObjectURL(photos[side].preview); } catch (e) {} } photos[side] = null; }
    each(function (tile) {
      var side = tile.getAttribute("data-cnic-side"), other = side === "front" ? "back" : "front";
      var input = tile.querySelector("input[type=file]"), img = tile.querySelector("img"), note = tile.querySelector("[data-cnic-note]");
      notes[side] = note ? note.textContent : "";
      input.setAttribute("accept", ACCEPT);
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        if (!f) return;
        tile.classList.remove("is-err", "is-set"); tile.classList.add("is-busy");
        if (note) note.textContent = "Preparing the photo…";
        prepare(f).then(function (out) {
          if (sameShot(out, photos[other])) {
            try { URL.revokeObjectURL(out.preview); } catch (e) {}
            throw new Error("This is the same photo as the " + other + ". Add a photo of the " + side + " of the card.");
          }
          drop(side);
          photos[side] = out;
          img.src = out.preview; img.hidden = false;
          tile.classList.remove("is-busy"); tile.classList.add("is-set");
          if (note) note.textContent = "Added. Tap to change";
          changed(null);
        }).catch(function (err) {
          drop(side); img.hidden = true; img.removeAttribute("src");
          tile.classList.remove("is-busy"); tile.classList.add("is-err");
          if (note) note.textContent = err.message;
          input.value = "";
          changed(err);
        });
      });
    });
    return {
      photos: function () { return photos; },
      ready: function () { return !!(photos.front && photos.back) && !sameShot(photos.front, photos.back); },
      busy: function () { return !!root.querySelector("[data-cnic-side].is-busy"); },
      reset: function () {
        each(function (tile) {
          var side = tile.getAttribute("data-cnic-side");
          var input = tile.querySelector("input[type=file]"), img = tile.querySelector("img"), note = tile.querySelector("[data-cnic-note]");
          drop(side); input.value = ""; img.hidden = true; img.removeAttribute("src");
          tile.classList.remove("is-busy", "is-err", "is-set");
          if (note) note.textContent = notes[side];
        });
      }
    };
  }

  window.NVCnic = { BUCKET: BUCKET, ACCEPT: ACCEPT, prepare: prepare, paths: paths, upload: upload, send: send, attach: attach,
                    status: status, signedUrls: signedUrls, picker: picker, isUuid: isUuid, sameShot: sameShot };
})();
