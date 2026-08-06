/* ============================================================================
   NovaX — local QR + Code128 generator (shared by client.html and admin.html)

   Extracted verbatim from client.html so the admin portal stops calling
   api.qrserver.com and barcode.tec-it.com. Two reasons that mattered:
     1. PRIVACY   every print sent that parcel's AWB and full tracking URL to
                  two third parties.
     2. AVAILABILITY  if either service is slow or down, printing and scanning
                  stop, and warehouse work stops with them.

   Exports window.__novaxQrSvg(text) and window.__novaxCode128Svg(text,w,h),
   both returning an inline SVG data URL usable directly as an <img src>.
   No dependencies, no network, works offline.
   ========================================================================== */
/* ===== NovaX fix (offline QR + Code128 generation) =====
       Every AWB used to be sent to api.qrserver.com and barcode.tec-it.com
       just to draw a shipping label, leaking the AWB / tracking URL of every
       parcel to two third parties on every print. Both codes are now built
       locally as inline SVG data URLs: no CDN, no network request, works
       fully offline. qrUrl(awb) and barcodeUrl(awb) keep their names and
       still return a string that can be dropped straight into an <img src>,
       so awbLabelHtml(), the print flows and the modals are unchanged. */
    (function(){
      /* ---- GF(256) tables + Reed-Solomon (QR error correction) ---- */
      var EXP=new Array(512), LOG=new Array(256);
      (function(){ var x=1; for(var i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=0x11d; } for(var j=255;j<512;j++) EXP[j]=EXP[j-255]; })();
      function gmul(a,b){ if(a===0||b===0) return 0; return EXP[LOG[a]+LOG[b]]; }
      function rsGenerator(deg){
        var poly=[1];
        for(var i=0;i<deg;i++){
          var next=new Array(poly.length+1); for(var z=0;z<next.length;z++) next[z]=0;
          for(var j=0;j<poly.length;j++){ next[j]^=poly[j]; next[j+1]^=gmul(poly[j],EXP[i]); }
          poly=next;
        }
        return poly;
      }
      function rsEncode(data,ecLen){
        var gen=rsGenerator(ecLen);
        var res=new Array(data.length+ecLen); for(var z=0;z<res.length;z++) res[z]=0;
        for(var i=0;i<data.length;i++) res[i]=data[i];
        for(var i2=0;i2<data.length;i2++){
          var coef=res[i2];
          if(coef!==0){ for(var j=0;j<gen.length;j++) res[i2+j]^=gmul(gen[j],coef); }
        }
        return res.slice(data.length);
      }
      /* Error correction level M, versions 1-6 (all blocks equal size). */
      var QR_M=[null,
        {total:26,ec:10,blocks:1},
        {total:44,ec:16,blocks:1},
        {total:70,ec:26,blocks:1},
        {total:100,ec:18,blocks:2},
        {total:134,ec:24,blocks:2},
        {total:172,ec:16,blocks:4}
      ];
      function utf8Bytes(text){
        var out=[], s=String(text===undefined||text===null?"":text);
        for(var i=0;i<s.length;i++){
          var c=s.charCodeAt(i);
          if(c<0x80) out.push(c);
          else if(c<0x800){ out.push(0xc0|(c>>6),0x80|(c&63)); }
          else { out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63)); }
        }
        return out;
      }
      function bitLen(n){ var l=0; while(n!==0){ n>>>=1; l++; } return l; }
      function formatBits(mask){
        var data=(0<<3)|mask; /* EC level M == 0b00 */
        var d=data<<10, rem=d;
        while(bitLen(rem)>=11) rem^=0x537<<(bitLen(rem)-11);
        return ((d|rem)^0x5412)&0x7fff;
      }
      function maskFn(m,r,c){
        switch(m){
          case 0: return ((r+c)%2)===0;
          case 1: return (r%2)===0;
          case 2: return (c%3)===0;
          case 3: return ((r+c)%3)===0;
          case 4: return ((Math.floor(r/2)+Math.floor(c/3))%2)===0;
          case 5: return (((r*c)%2)+((r*c)%3))===0;
          case 6: return (((((r*c)%2)+((r*c)%3))%2))===0;
          default: return (((((r+c)%2)+((r*c)%3))%2))===0;
        }
      }
      function qrMatrix(text){
        var bytes=utf8Bytes(text), version=0, v;
        for(v=1;v<=6;v++){ var cap=QR_M[v].total-QR_M[v].ec*QR_M[v].blocks; if(bytes.length<=cap-2){ version=v; break; } }
        if(!version) return null;
        var spec=QR_M[version], dataCw=spec.total-spec.ec*spec.blocks;
        var bits=[];
        function push(val,len){ for(var b=len-1;b>=0;b--) bits.push((val>>b)&1); }
        push(4,4); push(bytes.length,8);
        for(var i=0;i<bytes.length;i++) push(bytes[i],8);
        var capBits=dataCw*8, term=Math.min(4,capBits-bits.length);
        if(term>0) push(0,term);
        while(bits.length%8!==0) bits.push(0);
        var pad=[0xEC,0x11], pi=0;
        while(bits.length<capBits) push(pad[(pi++)%2],8);
        var cw=[];
        for(var k=0;k<bits.length;k+=8){ var byte=0; for(var b2=0;b2<8;b2++) byte=(byte<<1)|bits[k+b2]; cw.push(byte); }
        var perBlock=dataCw/spec.blocks, dBlocks=[], eBlocks=[];
        for(var b3=0;b3<spec.blocks;b3++){ var blk=cw.slice(b3*perBlock,(b3+1)*perBlock); dBlocks.push(blk); eBlocks.push(rsEncode(blk,spec.ec)); }
        var finalCw=[];
        for(var q=0;q<perBlock;q++) for(var b4=0;b4<spec.blocks;b4++) finalCw.push(dBlocks[b4][q]);
        for(var q2=0;q2<spec.ec;q2++) for(var b5=0;b5<spec.blocks;b5++) finalCw.push(eBlocks[b5][q2]);
        var size=17+4*version, mod=[], fn=[], r, c;
        for(r=0;r<size;r++){ var mr=[], fr=[]; for(c=0;c<size;c++){ mr.push(0); fr.push(false); } mod.push(mr); fn.push(fr); }
        function setFn(rr,cc,dark){ if(rr<0||cc<0||rr>=size||cc>=size) return; mod[rr][cc]=dark?1:0; fn[rr][cc]=true; }
        function finder(r0,c0){
          for(var dr=-1;dr<=7;dr++) for(var dc=-1;dc<=7;dc++){
            var rr=r0+dr, cc=c0+dc;
            if(rr<0||cc<0||rr>=size||cc>=size) continue;
            var inner=(dr>=0&&dr<=6&&dc>=0&&dc<=6), dark=false;
            if(inner){ var d=Math.max(Math.abs(dr-3),Math.abs(dc-3)); dark=(d!==2); }
            setFn(rr,cc,dark);
          }
        }
        finder(0,0); finder(0,size-7); finder(size-7,0);
        for(var t=8;t<size-8;t++){ setFn(6,t,(t%2)===0); setFn(t,6,(t%2)===0); }
        if(version>=2){
          var a=size-7;
          for(var ar=-2;ar<=2;ar++) for(var ac=-2;ac<=2;ac++) setFn(a+ar,a+ac,Math.max(Math.abs(ar),Math.abs(ac))!==1);
        }
        for(var f=0;f<9;f++){ if(!fn[8][f]) setFn(8,f,false); if(!fn[f][8]) setFn(f,8,false); }
        for(var f2=0;f2<8;f2++){ if(!fn[8][size-1-f2]) setFn(8,size-1-f2,false); if(!fn[size-1-f2][8]) setFn(size-1-f2,8,false); }
        setFn(size-8,8,true);
        var allBits=[];
        for(var i3=0;i3<finalCw.length;i3++) for(var b6=7;b6>=0;b6--) allBits.push((finalCw[i3]>>b6)&1);
        var bitIdx=0, up=true;
        for(var col=size-1;col>0;col-=2){
          if(col===6) col--;
          for(var step=0;step<size;step++){
            var row=up?(size-1-step):step;
            for(var off=0;off<2;off++){
              var cc2=col-off;
              if(fn[row][cc2]) continue;
              mod[row][cc2]=(bitIdx<allBits.length)?allBits[bitIdx]:0;
              bitIdx++;
            }
          }
          up=!up;
        }
        function placeFormat(m,mask){
          var f3=formatBits(mask), i4, bit;
          for(i4=0;i4<15;i4++){
            bit=(f3>>>i4)&1;
            if(i4<6) m[8][i4]=bit;
            else if(i4===6) m[8][7]=bit;
            else if(i4===7) m[8][8]=bit;
            else if(i4===8) m[7][8]=bit;
            else m[14-i4][8]=bit;
            if(i4<8) m[size-1-i4][8]=bit;
            else m[8][size-15+i4]=bit;
          }
          m[size-8][8]=1;
        }
        function penalty(m){
          var score=0, rr, cc, run, dark=0;
          for(rr=0;rr<size;rr++){ run=1; for(cc=1;cc<size;cc++){ if(m[rr][cc]===m[rr][cc-1]) run++; else { if(run>=5) score+=3+(run-5); run=1; } } if(run>=5) score+=3+(run-5); }
          for(cc=0;cc<size;cc++){ run=1; for(rr=1;rr<size;rr++){ if(m[rr][cc]===m[rr-1][cc]) run++; else { if(run>=5) score+=3+(run-5); run=1; } } if(run>=5) score+=3+(run-5); }
          for(rr=0;rr<size-1;rr++) for(cc=0;cc<size-1;cc++){ var vv=m[rr][cc]; if(vv===m[rr][cc+1]&&vv===m[rr+1][cc]&&vv===m[rr+1][cc+1]) score+=3; }
          var pat=[1,0,1,1,1,0,1];
          function look(r0,c0,dr,dc){
            for(var i5=0;i5<7;i5++){ var rr2=r0+dr*i5, cc3=c0+dc*i5; if(rr2<0||cc3<0||rr2>=size||cc3>=size||m[rr2][cc3]!==pat[i5]) return false; }
            var before=true, after=true, j;
            for(j=1;j<=4;j++){ var rb=r0-dr*j, cb=c0-dc*j; if(rb<0||cb<0||rb>=size||cb>=size||m[rb][cb]!==0){ before=false; break; } }
            for(j=7;j<11;j++){ var ra=r0+dr*j, ca=c0+dc*j; if(ra<0||ca<0||ra>=size||ca>=size||m[ra][ca]!==0){ after=false; break; } }
            return before||after;
          }
          for(rr=0;rr<size;rr++) for(cc=0;cc<size;cc++){ if(look(rr,cc,0,1)) score+=40; if(look(rr,cc,1,0)) score+=40; }
          for(rr=0;rr<size;rr++) for(cc=0;cc<size;cc++) if(m[rr][cc]) dark++;
          score+=Math.floor(Math.abs((dark*100/(size*size))-50)/5)*10;
          return score;
        }
        var best=null, bestScore=Infinity;
        for(var mk=0;mk<8;mk++){
          var cand=[];
          for(r=0;r<size;r++) cand.push(mod[r].slice());
          for(r=0;r<size;r++) for(c=0;c<size;c++) if(!fn[r][c]&&maskFn(mk,r,c)) cand[r][c]^=1;
          placeFormat(cand,mk);
          var sc=penalty(cand);
          if(sc<bestScore){ bestScore=sc; best=cand; }
        }
        return best;
      }
      function qrSvgDataUrl(text,px){
        var m=null;
        try{ m=qrMatrix(text); }catch(e){ m=null; }
        if(!m) return null;
        var n=m.length, quiet=4, total=n+quiet*2, rects="", r, c;
        for(r=0;r<n;r++){
          c=0;
          while(c<n){
            if(m[r][c]){ var start=c; while(c<n&&m[r][c]) c++; rects+='<rect x="'+(start+quiet)+'" y="'+(r+quiet)+'" width="'+(c-start)+'" height="1"/>'; }
            else c++;
          }
        }
        var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+px+'" height="'+px+'" viewBox="0 0 '+total+' '+total+'" shape-rendering="crispEdges"><rect width="'+total+'" height="'+total+'" fill="#ffffff"/><g fill="#000000">'+rects+'</g></svg>';
        return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
      }
      /* ---- Code128 (code set B) ---- */
      var C128=["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];
      function code128SvgDataUrl(value,widthPx,heightPx){
        var s=String(value===undefined||value===null?"":value).replace(/[^ -~]/g,"");
        if(!s) s=" ";
        var codes=[104], sum=104, i;
        for(i=0;i<s.length;i++){ var v=s.charCodeAt(i)-32; codes.push(v); sum+=v*(i+1); }
        codes.push(sum%103);
        codes.push(106);
        var pattern="";
        for(i=0;i<codes.length;i++) pattern+=C128[codes[i]];
        var units=20, k;
        for(k=0;k<pattern.length;k++) units+=Number(pattern.charAt(k));
        var x=10, bars="", isBar=true;
        for(k=0;k<pattern.length;k++){
          var w=Number(pattern.charAt(k));
          if(isBar) bars+='<rect x="'+x+'" y="0" width="'+w+'" height="100"/>';
          x+=w; isBar=!isBar;
        }
        var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+widthPx+'" height="'+heightPx+'" viewBox="0 0 '+units+' 100" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="'+units+'" height="100" fill="#ffffff"/><g fill="#000000">'+bars+'</g></svg>';
        return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
      }
      window.__novaxQrSvg=qrSvgDataUrl;
      window.__novaxCode128Svg=code128SvgDataUrl;
    })();
