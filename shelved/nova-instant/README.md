# Nova Instant, shelved 9 Oct 2026

Aisha: "shelf nova instant for now from admin client index until our operations are better".

Nothing was deleted. The Instant pages, their database and the rider app tab are untouched; only the ways in were taken out, and booking is paused (`nvi_config.open = false`).

## To bring it back

1. `update public.nvi_config set open = true where id;`
2. Put each block below back where its heading says. The styles for all of them are still in `index.html` and `client.html`.
3. Decide what Nova Recover keeps: it now uses the homepage nav slot, pill and dark band, and the portal's top-of-menu and Home slots.
4. Bump `CACHE` in `sw.js`, rebuild the portal bundle if `client-app.js` changed, push.

## index nav link (first item in #navLinks)

```html
<a class="nav-instant" href="instant.html?from=home">Nova Instant</a>
```

## index pill above the headline

```html
<a class="nvi-pill" href="instant.html?from=home"><b>New</b><span><strong>Nova Instant</strong> · one parcel across Karachi by bike</span><i aria-hidden="true">Book now &rarr;</i></a>
```

## index band + fare-check script (sat between the hero and FACTS)

```html
<!-- ═════ NOVA INSTANT ═════ -->
<section class="nvi" id="instant" aria-labelledby="nviH">
  <div class="wrap">
    <div class="nvi-grid">
      <div>
        <p class="nvi-eyebrow"><i aria-hidden="true"></i>Nova Instant · live in Karachi</p>
        <h2 id="nviH">One parcel. One rider. <em>Door to door</em> across Karachi.</h2>
        <p class="nvi-lead">Picked up from one door and handed over at another, by a Nova Instant bike rider. No NovaX account and no AWB. The fare is fixed by road distance before you book.</p>
        <div class="nvi-cta">
          <a class="btn btn-lg nvi-btn" href="instant.html?from=home">Book Nova Instant <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
          <p class="nvi-rate" style="margin:0"><b>Rs&nbsp;25 a km</b> · Rs&nbsp;100 minimum<br>Booking open 10&nbsp;am to 1&nbsp;am</p>
        </div>
      </div>
      <div>
        <figure class="tk" aria-labelledby="tkTitle">
          <div class="tk-head"><b id="tkTitle">Fare check</b><span>Rs 25 × km</span></div>
          <div class="tk-trips" role="group" aria-label="Example trips">
            <button type="button" aria-pressed="false" data-trip="0">Bahadurabad → Tariq Rd</button>
            <button type="button" aria-pressed="true" data-trip="1">Tariq Rd → Clifton</button>
            <button type="button" aria-pressed="false" data-trip="2">Saddar → Gulshan</button>
            <button type="button" aria-pressed="false" data-trip="3">DHA → North Nazimabad</button>
          </div>
          <div class="tk-map" aria-hidden="true">
            <svg viewBox="0 0 320 120">
              <path class="tk-road" id="tkRoad" d="M36 80 C 96 20, 150 104, 214 46"/>
              <path class="tk-line" id="tkLine" d="M36 80 C 96 20, 150 104, 214 46"/>
              <circle cx="36" cy="80" r="9" fill="#0fbf78" stroke="#fff" stroke-width="3"/>
              <rect id="tkB" x="205" y="37" width="18" height="18" rx="5" fill="#0d2920" stroke="#fff" stroke-width="3"/>
              <g class="tk-bike" id="tkBike" transform="translate(130 62)">
                <circle r="15" fill="#d9ff74" stroke="#0d2920" stroke-width="2"/>
                <g fill="none" stroke="#0d2920" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="translate(-9 -8) scale(.75)"><circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17l4-8h5l4 8M9.5 9l2 8M13 6h3"/></g>
              </g>
            </svg>
          </div>
          <div class="tk-legs">
            <div><small><i aria-hidden="true"></i>Pickup</small><b id="tkFrom">Tariq Road</b></div>
            <div><small><i aria-hidden="true"></i>Deliver to</small><b id="tkTo">Clifton Block 5</b></div>
          </div>
          <div class="tk-fare" aria-live="polite">
            <div><small>Fare</small><div class="tk-amt"><span>Rs</span><b id="tkFare">258</b></div></div>
            <div class="tk-km"><b id="tkKm">10.3 km</b><span id="tkHow">by road × Rs 25</span></div>
          </div>
          <div class="tk-pin"><b>4821</b><span>A PIN like this goes to the receiver. The rider hands over only against it.</span></div>
        </figure>
        <p class="tk-note">Example distances measured by road between these areas. Your fare is worked out for your exact two addresses before you book.</p>
      </div>
    </div>
    <ol class="nvi-how" aria-label="How Nova Instant works">
      <li><b>Set two places</b>Search an address or drop a pin for the pickup and the delivery. The fare appears straight away.</li>
      <li><b>A rider collects it</b>The sender pays in cash at pickup, or the receiver pays at the door. You choose when you book.</li>
      <li><b>Handed over against a PIN</b>Both sides follow it on one tracking link. No PIN, no handover.</li>
    </ol>
  </div>
</section>
<script>
/* Nova Instant fare check: four real road distances, the product's own fare rule. */
(function(){
  var T=[{ f:"Bahadurabad", t:"Tariq Road", km:1.9, y:[60,96] },{ f:"Tariq Road", t:"Clifton Block 5", km:10.3, y:[20,104] },
         { f:"Saddar", t:"Gulshan-e-Iqbal", km:17.5, y:[104,18] },{ f:"DHA Phase 6", t:"North Nazimabad", km:20, y:[14,100] }];
  var $=function(id){ return document.getElementById(id); }, line=$("tkLine"), road=$("tkRoad"); if(!line) return;
  function fare(km){ return Math.max(100,Math.round(25*km)); }
  function pick(i,anim){
    var x=T[i], ex=Math.round(96+x.km/20*196), ey=46, dx=ex-36;
    var d="M36 80 C "+Math.round(36+dx*.35)+" "+x.y[0]+", "+Math.round(36+dx*.65)+" "+x.y[1]+", "+ex+" "+ey;
    line.setAttribute("d",d); road.setAttribute("d",d);
    $("tkB").setAttribute("x",ex-9); $("tkB").setAttribute("y",ey-9);
    var L=0; try{ L=line.getTotalLength(); }catch(e){}
    if(L){ line.style.setProperty("--len",Math.ceil(L)); var p=line.getPointAtLength(L*.56); $("tkBike").setAttribute("transform","translate("+p.x.toFixed(1)+" "+p.y.toFixed(1)+")"); }
    line.classList.remove("go");
    if(anim&&!document.hidden){ void line.getBoundingClientRect(); line.classList.add("go"); }
    $("tkFrom").textContent=x.f; $("tkTo").textContent=x.t;
    $("tkFare").textContent=fare(x.km).toLocaleString("en-PK"); $("tkKm").textContent=x.km+" km";
    $("tkHow").textContent=fare(x.km)===100&&25*x.km<100?"minimum fare":"by road × Rs 25";
    [].forEach.call(document.querySelectorAll(".tk-trips button"),function(b){ b.setAttribute("aria-pressed",String(+b.getAttribute("data-trip")===i)); });
  }
  document.addEventListener("click",function(e){ var b=e.target.closest&&e.target.closest(".tk-trips button"); if(b) pick(+b.getAttribute("data-trip"),true); });
  pick(1,false);
})();
</script>
```

## index footer link (Get started column, after See the portal)

```html
        <a href="/instant.html">Book Nova Instant</a>
```

## client.html menu block (first child of #clientMenu)

```html
              <a class="nv-instant-menu" href="instant.html?from=portal" target="_blank" rel="noopener"><b>Nova Instant</b><span>One parcel across Karachi by bike</span></a>
```

## client.html Home card (in #client-dashboard, after #nvCodHero)

```html
              <!-- Nova Instant (5 Oct 2026): one parcel across Karachi by bike.
                   Its own product, opened in its own tab, so the portal and any
                   half-filled booking here stay as they are. -->
              <a class="nv-instant" href="instant.html?from=portal" target="_blank" rel="noopener">
                <span class="nv-instant-new">New</span>
                <span class="nv-instant-body"><b>Nova Instant</b><span>Need one parcel delivered across Karachi today? A bike rider, an upfront fare and no AWB. Rs 25 per km, Rs 100 minimum.</span></span>
                <span class="nv-instant-go">Book Nova Instant</span>
              </a>
```

## admin.html top tab link (after Support desk)

```html
<a class="tab-btn " href="instant-ops.html">Nova Instant</a>
```

## admin.html side menu link

```html
              <a class="admin-nav-main" href="instant-ops.html" style="text-decoration:none"><span>NOVA INSTANT</span><span class="chevron" aria-hidden="true">&#8599;</span></a>
```

## sitemap.xml entry (last in the file)

```html
  <url>
    <loc>https://novaxlogistics.com/instant.html</loc>
    <lastmod>2026-10-05</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
```
