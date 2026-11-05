/* 朴朴配送地图 —— 单页应用（高德 JS API 2.0） */
(function () {
  'use strict';

  var LS = 'pupu-map-v1';
  var COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#64748b'];
  var TYPES = { '门点': '#16a34a', '巷口': '#d97706', '楼栋': '#2563eb', '路口': '#64748b', '临时': '#dc2626' };

  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
    var la1 = a[1] * toR, la2 = b[1] * toR;
    var h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------------- 状态 ---------------- */
  function defaultConfig() {
    return {
      key: '', security: '', style: 'amap://styles/whitesmoke',
      center: [113.324, 23.098], zoom: 15,
      showAreas: true, showLines: true, showPoints: true, showLabels: true,
      overview: false
    };
  }
  function defaultState() {
    return { config: defaultConfig(), areas: [], lines: [], points: [] };
  }
  function loadState() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS));
      if (raw && raw.config) {
        var d = defaultState();
        return {
          config: Object.assign(d.config, raw.config),
          areas: raw.areas || [], lines: raw.lines || [], points: raw.points || []
        };
      }
    } catch (e) { }
    return defaultState();
  }
  var state = loadState();
  function saveState() {
    try { localStorage.setItem(LS, JSON.stringify(state)); }
    catch (e) { toast('本地存储已满，建议导出备份后删掉部分照片'); }
  }

  /* ---------------- 地图 ---------------- */
  var map = null, mouseTool = null, placeSearch = null;
  var overlays = { areas: [], lines: [], points: [] };
  var editMode = false, addPointMode = false, drawing = null;
  var suppressMapClick = 0;
  var currentId = null;

  function loadAMap() {
    return new Promise(function (resolve, reject) {
      if (window.AMap) return resolve();
      window._AMapSecurityConfig = { securityJsCode: state.config.security || '' };
      var s = document.createElement('script');
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(state.config.key) +
        '&plugin=AMap.MouseTool,AMap.PlaceSearch,AMap.Geocoder,AMap.Text,AMap.Geolocation';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('高德脚本加载失败')); };
      document.head.appendChild(s);
    });
  }

  function boot() {
    if (!state.config.key) { openSetup(); return; }
    loadAMap().then(initMap).catch(function (e) {
      toast(e.message || '地图加载失败');
      openSetup();
    });
  }

  function initMap() {
    map = new AMap.Map('map', {
      zoom: state.config.zoom,
      center: state.config.center,
      viewMode: '2D',
      features: ['bg', 'road', 'building'],
      mapStyle: state.config.style,
      resizeEnable: true,
      showLabel: true
    });
    map.on('complete', function () { renderAll(); if (map.setDefaultCursor) map.setDefaultCursor('default'); });
    map.on('click', onMapClick);
    var _loaded = false;
    map.on('complete', function () { _loaded = true; });
    setTimeout(function () {
      if (!_loaded) toast('地图没加载出来：检查 Key、域名白名单、安全密钥');
    }, 9000);

    AMap.plugin(['AMap.MouseTool', 'AMap.PlaceSearch', 'AMap.Geolocation'], function () {
      mouseTool = new AMap.MouseTool(map);
      placeSearch = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1, city: '全国', citylimit: false });
      buildEditBar();
      bindUI();
      renderAll();
    });

    $('#empty').classList.toggle('show', !state.points.length && !state.areas.length);
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    if (!map) return;
    renderAreas();
    renderLines();
    renderPoints();
    $('#empty').classList.toggle('show', !state.points.length && !state.areas.length && !state.lines.length);
    $('#chk-areas').checked = state.config.showAreas;
    $('#chk-lines').checked = state.config.showLines;
    $('#chk-points').checked = state.config.showPoints;
    $('#chk-labels').checked = state.config.showLabels;
    $('#chk-overview').checked = state.config.overview;
    document.body.classList.toggle('overview', !!state.config.overview);
  }

  function clearOverlays(kind) {
    overlays[kind].forEach(function (o) { map.remove(o); });
    overlays[kind] = [];
  }

  function renderAreas() {
    clearOverlays('areas');
    if (!state.config.showAreas) return;
    state.areas.forEach(function (a) {
      var poly = new AMap.Polygon({
        path: a.path,
        strokeColor: a.color,
        strokeWeight: 2,
        strokeOpacity: 0.9,
        fillColor: a.color,
        fillOpacity: 0.18,
        bubble: true,
        cursor: 'pointer',
        zIndex: 10
      });
      poly.on('click', function () { suppressMapClick = Date.now(); openArea(a.id); });
      map.add(poly);
      overlays.areas.push(poly);
      if (state.config.showLabels && a.name) {
        var c = centroid(a.path);
        var txt = new AMap.Text({
          text: a.name,
          position: c,
          anchor: 'center',
          bubble: true,
          style: {
            'font-size': '13px', 'font-weight': '700', 'color': '#1e293b',
            'background': 'rgba(255,255,255,.85)', 'border': '1px solid #e2e8f0',
            'border-radius': '8px', 'padding': '3px 8px', 'white-space': 'nowrap'
          }
        });
        map.add(txt);
        overlays.areas.push(txt);
      }
    });
  }

  function renderLines() {
    clearOverlays('lines');
    if (!state.config.showLines) return;
    state.lines.forEach(function (l) {
      var line = new AMap.Polyline({
        path: l.path,
        strokeColor: l.color || '#475569',
        strokeWeight: 3,
        strokeOpacity: 0.85,
        strokeStyle: l.dashed === false ? 'solid' : 'dashed',
        lineJoin: 'round',
        bubble: true,
        cursor: 'pointer',
        zIndex: 8
      });
      line.on('click', function () { suppressMapClick = Date.now(); openLine(l.id); });
      map.add(line);
      overlays.lines.push(line);
    });
  }

  function renderPoints() {
    clearOverlays('points');
    if (!state.config.showPoints) return;
    state.points.forEach(function (p) {
      var color = p.color || TYPES[p.type] || '#2563eb';
      var label = state.config.showLabels ? '<div class="lbl">' + esc(p.name) + '</div>' : '';
      var content = '<div class="pin' + (currentId === p.id ? ' sel' : '') + '">' +
        '<div class="dot" style="background:' + color + '"></div>' + label + '</div>';
      var marker = new AMap.Marker({
        position: [p.lng, p.lat],
        content: content,
        anchor: 'bottom-center',
        offset: new AMap.Pixel(0, 2),
        bubble: true,
        zIndex: 20
      });
      marker.on('click', function () { suppressMapClick = Date.now(); openPoint(p.id); });
      map.add(marker);
      overlays.points.push(marker);
    });
  }

  function centroid(path) {
    var x = 0, y = 0;
    path.forEach(function (p) { x += p[0]; y += p[1]; });
    return [x / path.length, y / path.length];
  }

  /* ---------------- 详情 ---------------- */
  function findPoint(id) { return state.points.find(function (p) { return p.id === id; }); }
  function findArea(id) { return state.areas.find(function (a) { return a.id === id; }); }
  function findLine(id) { return state.lines.find(function (l) { return l.id === id; }); }

  function openPoint(id) {
    var p = findPoint(id);
    if (!p) return;
    currentId = id;
    var color = p.color || TYPES[p.type] || '#2563eb';
    var html = '' +
      '<div class="sheet-title"><h2>' + esc(p.name) + '</h2>' +
      '<span class="badge" style="background:' + color + '">' + esc(p.type || '点位') + '</span></div>' +
      (p.alias ? '<div class="row"><div class="k">别名</div><div class="v">' + esc(p.alias) + '</div></div>' : '') +
      '<div class="rows">' +
      (p.entry ? '<div class="row"><div class="k">入口</div><div class="v">' + esc(p.entry) + '</div></div>' : '') +
      (p.walk ? '<div class="row"><div class="k">走法</div><div class="v">' + esc(p.walk) + '</div></div>' : '') +
      (p.caution ? '<div class="row"><div class="k">易错</div><div class="v">' + esc(p.caution) + '</div></div>' : '') +
      (p.date ? '<div class="row"><div class="k">确认</div><div class="v">' + esc(p.date) + '</div></div>' : '') +
      '</div>' +
      (p.photo ? '<img class="photo" src="' + p.photo + '" alt="点位照片">' : '') +
      '<div class="actions">' +
      '<button class="btn btn-primary" data-nav="ride">骑行导航</button>' +
      '<button class="btn btn-ghost" data-nav="walk">步行</button>' +
      '</div>' +
      '<div class="actions">' +
      '<button class="btn btn-ghost" data-edit="point">编辑</button>' +
      (editMode ? '<button class="btn btn-danger" data-del="point">删除</button>' : '') +
      '</div>';
    $('#sheet-body').innerHTML = html;
    $('#sheet-body').querySelector('[data-nav="ride"]').onclick = function () { navTo(p, 'ride'); };
    $('#sheet-body').querySelector('[data-nav="walk"]').onclick = function () { navTo(p, 'walk'); };
    $('#sheet-body').querySelector('[data-edit="point"]').onclick = function () { openPointForm(p); };
    var del = $('#sheet-body').querySelector('[data-del="point"]');
    if (del) del.onclick = function () {
      if (!confirm('删除「' + p.name + '」？')) return;
      state.points = state.points.filter(function (x) { return x.id !== p.id; });
      saveState(); renderPoints(); closeSheet();
    };
    $('#sheet').classList.add('show');
    renderPoints();
    if (!p.photo && !p.entry) toast('提示：点「编辑」补入口和照片');
  }

  function openArea(id) {
    var a = findArea(id);
    if (!a) return;
    currentId = id;
    $('#sheet-body').innerHTML =
      '<div class="sheet-title"><h2>' + esc(a.name || '未命名片区') + '</h2>' +
      '<span class="badge" style="background:' + a.color + '">片区</span></div>' +
      '<div class="rows"><div class="row"><div class="k">面积</div><div class="v">' + fmtArea(a.path) + '</div></div></div>' +
      '<div class="actions"><button class="btn btn-ghost" data-edit="area">改名 / 改色</button>' +
      (editMode ? '<button class="btn btn-danger" data-del="area">删除</button>' : '') + '</div>';
    $('#sheet-body').querySelector('[data-edit="area"]').onclick = function () { openAreaForm(a); };
    var del = $('#sheet-body').querySelector('[data-del="area"]');
    if (del) del.onclick = function () {
      if (!confirm('删除片区「' + (a.name || '') + '」？')) return;
      state.areas = state.areas.filter(function (x) { return x.id !== a.id; });
      saveState(); renderAreas(); closeSheet();
    };
    $('#sheet').classList.add('show');
  }

  function openLine(id) {
    var l = findLine(id);
    if (!l) return;
    $('#sheet-body').innerHTML =
      '<div class="sheet-title"><h2>' + esc(l.name || '未命名巷线') + '</h2><span class="badge" style="background:#475569">巷线</span></div>' +
      '<div class="actions"><button class="btn btn-ghost" data-edit="line">改名</button>' +
      (editMode ? '<button class="btn btn-danger" data-del="line">删除</button>' : '') + '</div>';
    $('#sheet-body').querySelector('[data-edit="line"]').onclick = function () { openLineForm(l); };
    var del = $('#sheet-body').querySelector('[data-del="line"]');
    if (del) del.onclick = function () {
      if (!confirm('删除巷线「' + (l.name || '') + '」？')) return;
      state.lines = state.lines.filter(function (x) { return x.id !== l.id; });
      saveState(); renderLines(); closeSheet();
    };
    $('#sheet').classList.add('show');
  }

  function fmtArea(path) {
    if (path.length < 3) return '—';
    var R = 6378137, s = 0;
    for (var i = 0; i < path.length; i++) {
      var a = path[i], b = path[(i + 1) % path.length];
      s += (b[0] - a[0]) * Math.PI / 180 * R * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180) * (b[1] - a[1]) * Math.PI / 180 * R;
    }
    var m2 = Math.abs(s);
    return m2 > 1e6 ? (m2 / 1e6).toFixed(2) + ' km²' : Math.round(m2) + ' m²';
  }

  function closeSheet() {
    $('#sheet').classList.remove('show');
    currentId = null;
    renderPoints();
  }

  function navTo(p, mode) {
    var url = 'https://uri.amap.com/navigation?to=' + p.lng + ',' + p.lat + ',' +
      encodeURIComponent(p.name) + '&mode=' + mode + '&coordinate=gaode&callnative=1&src=pupumap';
    window.open(url, '_blank');
  }

  /* ---------------- 表单 ---------------- */
  function openModal(html, mount) {
    $('#modal-card').innerHTML = html;
    $('#modal').classList.add('show');
    if (mount) mount($('#modal-card'));
  }
  function closeModal() { $('#modal').classList.remove('show'); }

  function openPointForm(p, forceNew) {
    var isNew = forceNew === true || !p;
    var d = p || {
      id: uid(), name: '', type: '门点', alias: '', entry: '', walk: '', caution: '',
      date: today(), photo: '', lng: window._newLng, lat: window._newLat
    };
    var color = d.color || TYPES[d.type] || '#16a34a';
    openModal(
      '<h3>' + (isNew ? '新增点位' : '编辑点位') + '</h3>' +
      '<div class="field"><label>名称 *（搜小区名 + ·门/栋）</label><input id="f-name" value="' + esc(d.name) + '" placeholder="例：佛堂坊4巷8号·门口"></div>' +
      '<div class="field"><label>类型</label><select id="f-type">' + Object.keys(TYPES).map(function (t) {
        return '<option' + (d.type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>别名（搜索用，可多个，用 / 分隔）</label><input id="f-alias" value="' + esc(d.alias) + '" placeholder="例：佛堂坊四巷 / 老陈家祠旁"></div>' +
      '<div class="field"><label>入口 / 门</label><input id="f-entry" value="' + esc(d.entry) + '" placeholder="例：东门，电动车能进，保安不拦"></div>' +
      '<div class="field"><label>走法</label><textarea id="f-walk" placeholder="例：进门左转，过儿童区，8栋第二排">' + esc(d.walk) + '</textarea></div>' +
      '<div class="field"><label>易错点</label><textarea id="f-caution" placeholder="例：2单元在楼背面；地库10点关">' + esc(d.caution) + '</textarea></div>' +
      '<div class="field"><label>确认日期</label><input id="f-date" type="date" value="' + esc(d.date) + '"></div>' +
      '<div class="field"><label>照片</label><input id="f-photo" type="file" accept="image/*"></div>' +
      (d.photo ? '<img class="photo" src="' + d.photo + '">' : '') +
      '<div class="field"><label>坐标</label><input value="' + (d.lng || '') + ', ' + (d.lat || '') + '" readonly></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="m-cancel">取消</button>' +
      '<button class="btn btn-primary" id="m-save">保存</button></div>',
      function (root) {
        var photo = d.photo;
        root.querySelector('#f-photo').onchange = function (e) {
          var f = e.target.files[0];
          if (!f) return;
          compress(f, function (data) { photo = data; toast('照片已就绪'); });
        };
        root.querySelector('#m-cancel').onclick = closeModal;
        root.querySelector('#m-save').onclick = function () {
          var name = root.querySelector('#f-name').value.trim();
          if (!name) { toast('请填名称'); return; }
          var obj = {
            id: d.id, name: name,
            type: root.querySelector('#f-type').value,
            alias: root.querySelector('#f-alias').value.trim(),
            entry: root.querySelector('#f-entry').value.trim(),
            walk: root.querySelector('#f-walk').value.trim(),
            caution: root.querySelector('#f-caution').value.trim(),
            date: root.querySelector('#f-date').value,
            photo: photo,
            lng: d.lng, lat: d.lat,
            color: TYPES[root.querySelector('#f-type').value]
          };
          if (isNew) state.points.push(obj);
          else {
            var i = state.points.findIndex(function (x) { return x.id === d.id; });
            if (i >= 0) state.points[i] = obj;
          }
          saveState(); renderPoints(); closeModal();
          toast(isNew ? '已添加' : '已保存');
          if (!isNew) openPoint(obj.id);
        };
      }
    );
  }

  function openAreaForm(a) {
    var isNew = !a;
    var d = a || { id: uid(), name: '', color: COLORS[0], path: window._newPath };
    openModal(
      '<h3>' + (isNew ? '命名片区' : '编辑片区') + '</h3>' +
      '<div class="field"><label>名称</label><input id="f-aname" value="' + esc(d.name) + '" placeholder="例：A 建华西"></div>' +
      '<div class="field"><label>颜色</label><div class="colors" id="f-colors">' +
      COLORS.map(function (c) {
        return '<div class="color-dot' + (c === d.color ? ' sel' : '') + '" data-c="' + c + '" style="background:' + c + '"></div>';
      }).join('') + '</div></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="m-cancel">取消</button>' +
      '<button class="btn btn-primary" id="m-save">保存</button></div>',
      function (root) {
        var color = d.color;
        root.querySelectorAll('.color-dot').forEach(function (el) {
          el.onclick = function () {
            color = el.dataset.c;
            root.querySelectorAll('.color-dot').forEach(function (x) { x.classList.remove('sel'); });
            el.classList.add('sel');
          };
        });
        root.querySelector('#m-cancel').onclick = closeModal;
        root.querySelector('#m-save').onclick = function () {
          var name = root.querySelector('#f-aname').value.trim() || '未命名片区';
          if (isNew) state.areas.push({ id: d.id, name: name, color: color, path: d.path });
          else {
            var i = state.areas.findIndex(function (x) { return x.id === d.id; });
            if (i >= 0) state.areas[i] = Object.assign(state.areas[i], { name: name, color: color });
          }
          saveState(); renderAreas(); closeModal();
        };
      }
    );
  }

  function openLineForm(l) {
    var isNew = !l;
    var d = l || { id: uid(), name: '', path: window._newPath };
    openModal(
      '<h3>' + (isNew ? '命名巷线' : '编辑巷线') + '</h3>' +
      '<div class="field"><label>名称</label><input id="f-lname" value="' + esc(d.name) + '" placeholder="例：佛堂坊二巷"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="m-cancel">取消</button>' +
      '<button class="btn btn-primary" id="m-save">保存</button></div>',
      function (root) {
        root.querySelector('#m-cancel').onclick = closeModal;
        root.querySelector('#m-save').onclick = function () {
          var name = root.querySelector('#f-lname').value.trim() || '未命名巷线';
          if (isNew) state.lines.push({ id: d.id, name: name, color: '#475569', path: d.path });
          else {
            var i = state.lines.findIndex(function (x) { return x.id === d.id; });
            if (i >= 0) state.lines[i].name = name;
          }
          saveState(); renderLines(); closeModal();
        };
      }
    );
  }

  function compress(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 720, w = img.width, h = img.height;
        if (w > max || h > max) {
          var r = Math.min(max / w, max / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL('image/jpeg', 0.62));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------------- 编辑流程 ---------------- */
  function setEditMode(on) {
    editMode = on;
    addPointMode = false;
    $('#btn-edit').classList.toggle('active', on);
    var bar = $('#editbar');
    if (!bar) return;
    bar.style.display = on ? 'flex' : 'none';
    if (!on) { drawing = null; if (mouseTool) mouseTool.close(true); }
  }

  function buildEditBar() {
    if ($('#editbar')) return;
    var bar = document.createElement('div');
    bar.id = 'editbar';
    bar.style.cssText = 'position:absolute;z-index:28;left:10px;right:10px;top:calc(58px + env(safe-area-inset-top));' +
      'display:none;gap:6px;background:#ffffffee;border-radius:12px;padding:6px;box-shadow:0 2px 10px #0000001a';
    bar.innerHTML =
      '<button class="btn btn-ghost" data-act="area" style="padding:8px;font-size:13px">画片区</button>' +
      '<button class="btn btn-ghost" data-act="line" style="padding:8px;font-size:13px">画巷线</button>' +
      '<button class="btn btn-ghost" data-act="point" style="padding:8px;font-size:13px">加点</button>' +
      '<button class="btn btn-ghost" data-act="fit" style="padding:8px;font-size:13px">全览</button>';
    document.body.appendChild(bar);
    bar.addEventListener('click', function (e) {
      var act = e.target.dataset.act;
      if (!act) return;
      if (act === 'area') startDraw('polygon');
      if (act === 'line') startDraw('polyline');
      if (act === 'point') { addPointMode = !addPointMode; toast(addPointMode ? '点击地图添加点位' : '已关闭加点'); }
      if (act === 'fit') fitAll();
    });
  }

  function startDraw(kind) {
    if (!mouseTool) { toast('地图还没准备好'); return; }
    drawing = kind;
    addPointMode = false;
    mouseTool.close(true);
    var opts = {
      strokeColor: '#2563eb', strokeWeight: 2, strokeOpacity: 1,
      fillColor: '#3b82f6', fillOpacity: 0.15, strokeStyle: 'solid'
    };
    if (kind === 'polygon') mouseTool.polygon(opts); else mouseTool.polyline(opts);
    toast(kind === 'polygon' ? '点击地图画片区，双击结束' : '点击地图画巷线，双击结束');
  }

  function onDraw(e) {
    var obj = e.obj;
    var path = obj.getPath().map(function (p) { return [p.lng, p.lat]; });
    mouseTool.close(true);
    drawing = null;
    if (!path.length) return;
    window._newPath = path;
    if (obj.CLASS_NAME === 'AMap.Polygon') openAreaForm(null);
    else openLineForm(null);
  }

  function onMapClick(e) {
    if (Date.now() - suppressMapClick < 400) return;
    if (!editMode) return;
    if (addPointMode) {
      window._newLng = e.lnglat.getLng();
      window._newLat = e.lnglat.getLat();
      openPointForm(null);
    }
  }

  function fitAll() {
    var all = overlays.areas.concat(overlays.lines, overlays.points);
    if (!all.length) { toast('还没有可定位的内容'); return; }
    map.setFitView(all, false, [70, 40, 70, 40]);
  }

  /* ---------------- 搜索 ---------------- */
  function searchLocal(kw) {
    kw = kw.trim().toLowerCase();
    if (!kw) { $('#results').classList.remove('show'); return; }
    var hits = state.points.filter(function (p) {
      return [p.name, p.alias, p.entry, p.walk, p.caution, p.type].join(' ').toLowerCase().indexOf(kw) >= 0;
    }).slice(0, 20);
    var html = hits.map(function (p) {
      return '<div class="result" data-id="' + p.id + '"><div><div class="rname">' + esc(p.name) +
        '</div><div class="raddr">' + esc(p.alias || p.entry || '') + '</div></div>' +
        '<span class="rtag" style="background:' + (p.color || '#2563eb') + '1a;color:' + (p.color || '#2563eb') + '">' + esc(p.type || '') + '</span></div>';
    }).join('');
    html += '<div class="result" data-poi="1"><div><div class="rname">在高德地图里搜「' + esc(kw) + '」</div>' +
      '<div class="raddr">找小区/店铺，再点「加为点」</div></div><span class="rtag">地图</span></div>';
    $('#results').innerHTML = html;
    $('#results').classList.add('show');
    Array.prototype.forEach.call($('#results').querySelectorAll('.result'), function (el) {
      el.onclick = function () {
        if (el.dataset.poi) { poiSearch(kw); return; }
        var p = findPoint(el.dataset.id);
        if (!p) return;
        map.setZoomAndCenter(18, [p.lng, p.lat]);
        openPoint(p.id);
        $('#results').classList.remove('show');
      };
    });
  }

  function poiSearch(kw) {
    if (!placeSearch) { toast('搜索组件未就绪'); return; }
    placeSearch.search(kw, function (status, result) {
      if (status !== 'complete' || !result.poiList || !result.poiList.pois.length) {
        toast('高德也没搜到，换个词或让客户发定位');
        return;
      }
      var pois = result.poiList.pois.slice(0, 10);
      $('#results').innerHTML = pois.map(function (p, i) {
        return '<div class="result" data-poi-idx="' + i + '"><div><div class="rname">' + esc(p.name) +
          '</div><div class="raddr">' + esc(p.address || '') + '</div></div><span class="rtag">地图</span></div>';
      }).join('');
      $('#results').classList.add('show');
      Array.prototype.forEach.call($('#results').querySelectorAll('.result'), function (el) {
        el.onclick = function () {
          var p = pois[+el.dataset.poiIdx];
          var loc = [p.location.lng, p.location.lat];
          map.setZoomAndCenter(17, loc);
          window._newLng = loc[0]; window._newLat = loc[1];
          window._newName = p.name;
          openPointForm({ id: uid(), name: p.name, type: '门点', alias: '', entry: '', walk: '', caution: '', date: today(), photo: '', lng: loc[0], lat: loc[1] }, true);
          $('#results').classList.remove('show');
        };
      });
    });
  }

  /* ---------------- 设置 / 数据 ---------------- */
  function openSetup() {
    openModal(
      '<h3>先填高德 Key</h3>' +
      '<div class="field"><label>Key（Web端 JS API）</label><input id="s-key" value="' + esc(state.config.key) + '" placeholder="在 console.amap.com 创建"></div>' +
      '<div class="field"><label>安全密钥 securityJsCode</label><input id="s-sec" value="' + esc(state.config.security) + '" placeholder="和 Key 一起生成"></div>' +
      '<div class="field"><label>地图样式</label><select id="s-style">' +
      [['amap://styles/whitesmoke', '浅色（推荐）'], ['amap://styles/grey', '灰'], ['amap://styles/light', '明亮'],
      ['amap://styles/normal', '标准'], ['amap://styles/dark', '深色']].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.config.style === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field" style="font-size:12px;color:#64748b;line-height:1.6">' +
      '1. 登录 console.amap.com → 应用管理 → 创建应用 → 添加 Key，服务平台选「Web端(JS API)」<br>' +
      '2. 域名白名单填你部署的域名（GitHub Pages 就填 xxx.github.io）<br>' +
      '3. 把 Key 和「安全密钥」一起填到这里</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="s-cancel">取消</button>' +
      '<button class="btn btn-primary" id="s-save">保存并重载</button></div>',
      function (root) {
        root.querySelector('#s-cancel').onclick = closeModal;
        root.querySelector('#s-save').onclick = function () {
          state.config.key = root.querySelector('#s-key').value.trim();
          state.config.security = root.querySelector('#s-sec').value.trim();
          state.config.style = root.querySelector('#s-style').value;
          saveState();
          location.reload();
        };
      }
    );
  }

  function openSettings() {
    openModal(
      '<h3>设置 / 数据</h3>' +
      '<div class="field"><label>Key</label><input id="g-key" value="' + esc(state.config.key) + '"></div>' +
      '<div class="field"><label>安全密钥</label><input id="g-sec" value="' + esc(state.config.security) + '"></div>' +
      '<div class="field"><label>地图样式</label><select id="g-style">' +
      [['amap://styles/whitesmoke', '浅色（推荐）'], ['amap://styles/grey', '灰'], ['amap://styles/light', '明亮'],
      ['amap://styles/normal', '标准'], ['amap://styles/dark', '深色']].map(function (o) {
        return '<option value="' + o[0] + '"' + (state.config.style === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="actions"><button class="btn btn-primary" id="g-save">保存并重载</button></div>' +
      '<div class="actions"><button class="btn btn-ghost" id="g-export">导出 JSON 备份</button>' +
      '<button class="btn btn-ghost" id="g-import">导入 JSON</button></div>' +
      '<input type="file" id="g-file" accept="application/json" style="display:none">' +
      '<div class="actions"><button class="btn btn-danger" id="g-clear">清空所有数据</button></div>' +
      '<div class="field" style="font-size:12px;color:#64748b;margin-top:12px">' +
      '数据存在这台手机的浏览器里。换手机、清缓存前，务必先导出备份。</div>',
      function (root) {
        root.querySelector('#g-save').onclick = function () {
          state.config.key = root.querySelector('#g-key').value.trim();
          state.config.security = root.querySelector('#g-sec').value.trim();
          state.config.style = root.querySelector('#g-style').value;
          saveState(); location.reload();
        };
        root.querySelector('#g-export').onclick = exportJSON;
        root.querySelector('#g-import').onclick = function () { root.querySelector('#g-file').click(); };
        root.querySelector('#g-file').onchange = importJSON;
        root.querySelector('#g-clear').onclick = function () {
          if (!confirm('清空本机所有点位、片区、巷线？')) return;
          localStorage.removeItem(LS);
          location.reload();
        };
      }
    );
  }

  function exportJSON() {
    var data = JSON.parse(JSON.stringify(state));
    delete data.config.key; delete data.config.security;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '朴朴地图备份-' + today() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  function importJSON(e) {
    var f = e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || (!d.points && !d.areas && !d.lines)) throw new Error('文件格式不对');
        if (!confirm('导入会覆盖当前数据，继续？')) return;
        state.areas = d.areas || [];
        state.lines = d.lines || [];
        state.points = d.points || [];
        saveState(); renderAll(); closeModal();
        toast('已导入 ' + state.points.length + ' 个点');
      } catch (err) { toast('导入失败：' + err.message); }
    };
    r.readAsText(f);
  }

  /* ---------------- UI 绑定 ---------------- */
  function bindUI() {
    $('#btn-edit').onclick = function () {
      setEditMode(!editMode);
      toast(editMode ? '编辑模式：可画片区、巷线、加点' : '已退出编辑');
    };
    $('#btn-layers').onclick = function () {
      $('#panel').classList.toggle('show');
    };
    $('#btn-settings').onclick = function () { $('#panel').classList.remove('show'); openSettings(); };
    $('#btn-locate').onclick = function () {
      $('#panel').classList.remove('show');
      if (!navigator.geolocation) { toast('设备不支持定位'); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = [pos.coords.longitude, pos.coords.latitude];
        map.setZoomAndCenter(17, c);
        toast('已定位');
      }, function () { toast('定位失败：检查浏览器权限'); }, { enableHighAccuracy: true, timeout: 8000 });
    };
    $('#chk-areas').onchange = function (e) { state.config.showAreas = e.target.checked; saveState(); renderAreas(); };
    $('#chk-lines').onchange = function (e) { state.config.showLines = e.target.checked; saveState(); renderLines(); };
    $('#chk-points').onchange = function (e) { state.config.showPoints = e.target.checked; saveState(); renderPoints(); };
    $('#chk-labels').onchange = function (e) { state.config.showLabels = e.target.checked; saveState(); renderAll(); };
    $('#chk-overview').onchange = function (e) {
      state.config.overview = e.target.checked;
      document.body.classList.toggle('overview', e.target.checked);
      saveState();
      toast(e.target.checked ? '概图模式：只看片区' : '作业模式：显示点位');
    };
    var q = $('#q');
    var timer = null;
    q.oninput = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { searchLocal(q.value); }, 200);
    };
    q.onkeydown = function (e) { if (e.key === 'Enter') { searchLocal(q.value); poiSearch(q.value.trim()); } };
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#results') && !e.target.closest('.search')) $('#results').classList.remove('show');
      if (!e.target.closest('#panel') && !e.target.closest('#btn-layers')) $('#panel').classList.remove('show');
    });
    var sheet = $('#sheet');
    var sy = 0;
    sheet.addEventListener('touchstart', function (e) { sy = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchend', function (e) {
      if (e.changedTouches[0].clientY - sy > 80) closeSheet();
    });
    if (mouseTool) mouseTool.on('draw', onDraw);
  }

  window.addEventListener('DOMContentLoaded', function () {
    if (window.AMap) { /* 已加载 */ }
    boot();
  });
})();
