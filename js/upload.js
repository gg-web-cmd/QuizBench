/* 파일을 올려서 푸는 길.
 *
 * 창을 찍는 대신 파일을 그대로 준다. 세 갈래로 갈린다.
 *
 *   사진(jpg·png·webp…) → 그대로 PNG 로 바꿔 보낸다
 *   PDF                  → **브라우저가** 쪽마다 그림으로 구워 보낸다 (pdf.js)
 *   워드·한글 문서 등     → 서버가 글자를 뽑아 글로 푼다
 *
 * PDF 를 브라우저가 굽는 까닭: 컴퓨터에 따로 깔 것이 없고(엣지·크롬이 이미 하는 일),
 * 원본 파일은 읽기만 하며, 인터넷도 쓰지 않는다. pdf.js 알맹이는 exe 안에 들어 있다.
 * (C:\vibe\PDF이미지변환기 와 같은 방식이다)
 */
(function (root) {
  'use strict';

  /* 사진으로 다룰 것 · 글자를 뽑을 것 */
  var IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'];
  var DOC_EXT = ['hwp', 'hwpx', 'hwt', 'doc', 'docx', 'odt', 'pptx', 'odp', 'xlsx', 'ods',
                 'txt', 'md', 'csv', 'tsv', 'rtf', 'html', 'htm', 'xml', 'json', 'log'];

  /* 한 쪽을 얼마나 크게 그릴지. 너무 작으면 AI 가 글자를 못 읽고,
   * 너무 크면 보내는 데 오래 걸리고 값도 더 든다. 긴 변 1800px 이면 시험지 글자가 또렷하다. */
  var MAX_SIDE = 1800;
  var MAX_PAGES = 30;

  var pdfjs = null;
  var loading = null;

  /** pdf.js 를 한 번만 불러온다. 곁다리 파일은 모두 우리 서버 안에 있다. */
  function pdfReady() {
    if (pdfjs) return Promise.resolve(pdfjs);
    if (loading) return loading;
    loading = import('/vendor/pdf.min.mjs').then(function (mod) {
      mod.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      pdfjs = mod;
      return mod;
    });
    return loading;
  }

  function extOf(name) {
    var m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : '';
  }

  function readAs(file, how) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('파일을 읽지 못했습니다')); };
      if (how === 'buffer') fr.readAsArrayBuffer(file);
      else fr.readAsDataURL(file);
    });
  }

  /** 캔버스를 PNG 글자(base64)로 */
  function canvasPng(cv) {
    return cv.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }

  /**
   * 화면에 안 붙는 캔버스를 만든다. 화면에 붙은 캔버스보다 메모리를 덜 쓴다.
   *
   * ※ 예전에는 이걸로 "창이 뒤에 있으면 멈추는" 일이 풀린다고 적어 두었으나
   *   재 보니 **거짓이었다.** 멎는 까닭은 캔버스가 아니라 pdf.js 가 다음 조각을
   *   requestAnimationFrame 으로 잡는 데 있다. 그건 아래 pdfToPages 에서 푼다.
   */
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') {
      try { return new OffscreenCanvas(w, h); } catch (_) { /* 아래로 */ }
    }
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  /** 어느 쪽 캔버스든 PNG base64 로 */
  function toPng(cv) {
    if (typeof cv.convertToBlob === 'function') {
      return cv.convertToBlob({ type: 'image/png' }).then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () {
            resolve(String(fr.result).replace(/^data:image\/png;base64,/, ''));
          };
          fr.onerror = function () { reject(new Error('그림을 만들지 못했습니다')); };
          fr.readAsDataURL(blob);
        });
      });
    }
    return Promise.resolve(canvasPng(cv));
  }

  /** 사진 한 장 → PNG (너무 크면 줄인다) */
  function imageToPage(file) {
    return readAs(file, 'url').then(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * scale));
          var h = Math.max(1, Math.round(img.naturalHeight * scale));
          var cv = makeCanvas(w, h);
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';                     // 투명한 PNG 는 글자가 안 보일 수 있다
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          toPng(cv).then(function (png) { resolve({ png: png, w: w, h: h }); }, reject);
        };
        img.onerror = function () { reject(new Error('사진을 열지 못했습니다')); };
        img.src = url;
      });
    });
  }

  /** PDF → 쪽마다 PNG. onPage(몇째, 전체) 로 어디까지 갔는지 알려 준다. */
  function pdfToPages(file, onPage) {
    return pdfReady().then(function (mod) {
      return readAs(file, 'buffer').then(function (buf) {
        return mod.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: '/vendor/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/vendor/standard_fonts/',
          wasmUrl: '/vendor/wasm/',
          iccUrl: '/vendor/iccs/',
        }).promise;
      }).then(function (doc) {
        var total = Math.min(doc.numPages, MAX_PAGES);
        var pages = [];
        var chain = Promise.resolve();
        for (var i = 1; i <= total; i++) {
          (function (no) {
            chain = chain.then(function () {
              return doc.getPage(no).then(function (page) {
                var base = page.getViewport({ scale: 1 });
                var scale = Math.min(3, MAX_SIDE / Math.max(base.width, base.height));
                var vp = page.getViewport({ scale: scale });
                var w = Math.max(1, Math.round(vp.width));
                var h = Math.max(1, Math.round(vp.height));
                var cv = makeCanvas(w, h);
                var ctx = cv.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, w, h);
                /* ★ intent:'print' 가 핵심이다.
                 *
                 * 기본값(display)으로 그리면 pdf.js 는 다음 조각을 requestAnimationFrame
                 * 으로 잡는다. 그런데 브라우저는 **화면에 안 그려지는 창의 rAF 를 안 쏜다.**
                 * 창을 내리거나 다른 창으로 덮기만 해도 그렇고, 그때 document.hidden 은
                 * 그대로 false 라 "창이 보이는지"로는 알아챌 수조차 없다. 그러면
                 * "PDF N쪽 중 M쪽을 그리는 중…" 에서 영영 멎는다 — 올려 놓고 다른 일
                 * 하러 간 사이에 벌어지는 일이라 더 나쁘다.
                 *
                 * print 뜻으로 그리면 pdf.js 가 rAF 대신 마이크로태스크로 잇는다.
                 * 창이 가려져 있든 내려가 있든 끝까지 그리고, 덤으로 훨씬 빠르다
                 * (실측: 한 쪽에 12초 → 1초). 종이에 찍을 때와 같은 모습이라
                 * 시험지·문제지에는 오히려 알맞다. */
                return page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise.then(function () {
                  return toPng(cv);
                }).then(function (png) {
                  pages.push({ png: png, w: w, h: h });
                  if (onPage) onPage(no, total);
                  page.cleanup();
                });
              });
            });
          })(i);
        }
        return chain.then(function () {
          return { pages: pages, total: doc.numPages, used: total };
        });
      });
    });
  }

  /**
   * 고른 파일을 다룬다.
   *   onStep(글) 로 무슨 일을 하는 중인지 알려 준다.
   * 돌려주는 것: { kind:'pages'|'doc', ... }
   */
  function handle(file, onStep) {
    var ext = extOf(file.name);

    if (IMAGE_EXT.indexOf(ext) >= 0) {
      if (onStep) onStep('사진을 읽는 중…');
      return imageToPage(file).then(function (p) {
        return { kind: 'pages', name: file.name, pages: [p] };
      });
    }

    if (ext === 'pdf') {
      if (onStep) onStep('PDF 를 여는 중…');
      return pdfToPages(file, function (n, total) {
        if (onStep) onStep('PDF ' + total + '쪽 중 ' + n + '쪽을 그리는 중…');
      }).then(function (r) {
        return {
          kind: 'pages', name: file.name, pages: r.pages,
          note: r.total > r.used ? ('쪽이 ' + r.total + '장이라 앞 ' + r.used + '장만 보냅니다') : '',
        };
      });
    }

    if (DOC_EXT.indexOf(ext) >= 0) {
      if (onStep) onStep('문서에서 글자를 뽑는 중…');
      return readAs(file, 'url').then(function (url) {
        return { kind: 'doc', name: file.name, data: String(url).replace(/^data:[^,]*,/, '') };
      });
    }

    return Promise.reject(new Error('"' + (ext || '확장자 없음') + '" 는 다룰 수 없는 형식입니다.\n'
      + '사진(jpg·png), PDF, 한글·워드 문서를 올려 주세요.'));
  }

  root.Upload = {
    handle: handle,
    IMAGE_EXT: IMAGE_EXT,
    DOC_EXT: DOC_EXT,
    accept: '.' + IMAGE_EXT.join(',.') + ',.pdf,.' + DOC_EXT.join(',.'),
  };
})(window);
