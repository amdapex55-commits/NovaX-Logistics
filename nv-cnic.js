/* NovaX CNIC photos (30 Sep 2026).
   One implementation for signup (index.html), the merchant Profile
   (client-app.js) and admin review (admin.html). Photos go to the private
   client-kyc bucket as <client_id>/cnic-front-<ms>.jpg and cnic-back-<ms>.jpg.
   Who may upload or see them is decided by the database
   (sql_novax_client_cnic_20260930.sql), never by this file. */
(function () {
  "use strict";
  var BUCKET = "client-kyc";
  var MAX_EDGE = 1600;                     // long side after shrinking; text stays readable
  var MIN_LONG = 600, MIN_SHORT = 380;     // smaller than this cannot be read
  var MAX_IN = 25 * 1024 * 1024, MAX_OUT = 2.8 * 1024 * 1024;   // bucket limit is 3 MB

  function fail(msg) { return Promise.reject(new Error(msg)); }

  /* Shrink a phone photo to a JPEG of about 200 KB. Redrawing it also drops
     the hidden data phones store in photos (location, phone model). */
  function prepare(file) {
    if (!file) return fail("Choose a photo.");
    if (file.type && !/^image\//i.test(file.type)) return fail("That file is not a photo. Choose a photo of the card.");
    if (file.size > MAX_IN) return fail("That photo is too large. Take a new photo with your phone camera.");
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w0 = img.naturalWidth, h0 = img.naturalHeight;
        if (Math.max(w0, h0) < MIN_LONG || Math.min(w0, h0) < MIN_SHORT) {
          URL.revokeObjectURL(url);
          reject(new Error("That photo is too small to read. Take a closer photo of the card."));
          return;
        }
        var k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
        var w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        var g = c.getContext("2d");
        if (!g) { URL.revokeObjectURL(url); reject(new Error("This browser cannot prepare photos. Try Chrome.")); return; }
        g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        (function encode(q) {
          c.toBlob(function (b) {
            if (!b) { reject(new Error("That photo could not be prepared. Try another photo.")); return; }
            if (b.size > MAX_OUT && q > 0.5) { encode(q - 0.15); return; }
            if (b.size > MAX_OUT) { reject(new Error("That photo is too large. Take a new photo with your phone camera.")); return; }
            resolve({ blob: b, width: w, height: h, preview: URL.createObjectURL(b) });
          }, "image/jpeg", q);
        })(0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("This photo can't be opened here. Take it with your phone camera, or use a JPG or PNG."));
      };
      img.src = url;
    });
  }

  function isUuid(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || "")); }
  function paths(clientId) {
    var id = String(clientId).toLowerCase(), t = Date.now();
    return { front: id + "/cnic-front-" + t + ".jpg", back: id + "/cnic-back-" + (t + 1) + ".jpg" };
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
  function putOne(sb, path, photo) {
    return Promise.resolve(sb.storage.from(BUCKET).upload(path, photo.blob || photo,
      { contentType: "image/jpeg", upsert: false, cacheControl: "60" }))
      .then(function (r) { data(r, "The photo did not upload."); return path; });
  }
  /* Both photos, or neither is recorded. Returns { front, back } paths. */
  function upload(sb, clientId, front, back, ms) {
    if (!sb || !sb.storage || !sb.rpc) return fail("Not connected. Refresh the page and try again.");
    if (!isUuid(clientId)) return fail("Your account is still loading. Try again in a moment.");
    if (!front || !back) return fail("Add a photo of the front and the back of the CNIC.");
    var p = paths(clientId);
    return timeout(Promise.all([putOne(sb, p.front, front), putOne(sb, p.back, back)]), ms || 90000,
      "The upload is taking too long. Check your connection and try again.").then(function () { return p; });
  }
  /* Merchant: upload, then record them for checking. */
  function send(sb, clientId, front, back, ms) {
    return upload(sb, clientId, front, back, ms).then(function (p) {
      return Promise.resolve(sb.rpc("client_kyc_submit", { p_front: p.front, p_back: p.back }))
        .then(function (r) { return data(r, "The CNIC was not saved. Try again."); });
    });
  }
  /* Admin: photos the merchant sent another way (WhatsApp, email). */
  function attach(sb, clientId, front, back) {
    return upload(sb, clientId, front, back).then(function (p) {
      return Promise.resolve(sb.rpc("admin_kyc_attach", { p_client: clientId, p_front: p.front, p_back: p.back }))
        .then(function (r) { return data(r, "The CNIC was not saved. Try again."); });
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
    each(function (tile) {
      var side = tile.getAttribute("data-cnic-side");
      var input = tile.querySelector("input[type=file]"), img = tile.querySelector("img"), note = tile.querySelector("[data-cnic-note]");
      notes[side] = note ? note.textContent : "";
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        if (!f) return;
        tile.classList.remove("is-err", "is-set"); tile.classList.add("is-busy");
        if (note) note.textContent = "Preparing the photo…";
        prepare(f).then(function (out) {
          if (photos[side] && photos[side].preview) { try { URL.revokeObjectURL(photos[side].preview); } catch (e) {} }
          photos[side] = out;
          img.src = out.preview; img.hidden = false;
          tile.classList.remove("is-busy"); tile.classList.add("is-set");
          if (note) note.textContent = "Added. Tap to change";
          changed(null);
        }, function (err) {
          if (photos[side] && photos[side].preview) { try { URL.revokeObjectURL(photos[side].preview); } catch (e) {} }
          photos[side] = null; img.hidden = true; img.removeAttribute("src");
          tile.classList.remove("is-busy"); tile.classList.add("is-err");
          if (note) note.textContent = err.message;
          input.value = "";
          changed(err);
        });
      });
    });
    return {
      photos: function () { return photos; },
      ready: function () { return !!(photos.front && photos.back); },
      busy: function () { return !!root.querySelector("[data-cnic-side].is-busy"); },
      reset: function () {
        each(function (tile) {
          var side = tile.getAttribute("data-cnic-side");
          var input = tile.querySelector("input[type=file]"), img = tile.querySelector("img"), note = tile.querySelector("[data-cnic-note]");
          if (photos[side] && photos[side].preview) { try { URL.revokeObjectURL(photos[side].preview); } catch (e) {} }
          photos[side] = null; input.value = ""; img.hidden = true; img.removeAttribute("src");
          tile.classList.remove("is-busy", "is-err", "is-set");
          if (note) note.textContent = notes[side];
        });
      }
    };
  }

  window.NVCnic = { BUCKET: BUCKET, prepare: prepare, paths: paths, upload: upload, send: send, attach: attach,
                    status: status, signedUrls: signedUrls, picker: picker, isUuid: isUuid };
})();
