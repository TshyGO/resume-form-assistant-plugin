// #301 北森 2022 版网申表单（*.zhiye.com）的替身，照金发 /form 加载的公开代码写：
// - 表单项：div.fields-col > div.form-item.form-item--phoenix > 标题 + div.form-item__control > 控件 + span.form-item__error。
//   文本框失焦时提交，提交时同步校验；开始 / 结束时间成对校验：开始晚于结束时在刚改的那一项上报错，满足后两边都清掉。
// - 常量选择器（民族、政治面貌、学历）：弹层左边是列表，字典第一次点开时才从后台拉，期间只有一个不带文字的加载图标；
//   搜索时命中的字放进 <mark>，其余的字放进 <span>（react-highlight-words）。右边「已选」栏一打开就画出来
//   （「已选 0/1」「清空已选」，没选时写着「请在左侧选择内容」）。点单选圈才算勾上，点「确定」后组件里才显示所选。
// 只有虚构的值。data-rect="top,left,width,height" 给整条填写流程的测试摆位置，控件层的测试用不到。

// 民族字典的前 16 项。
const ETHNIC = ["汉族", "蒙古族", "回族", "藏族", "维吾尔族", "苗族", "彝族", "壮族", "布依族", "朝鲜族", "满族", "侗族", "瑶族", "白族", "土家族", "哈尼族"];

function textItem(id, label, top, { value = "" } = {}) {
  return `<div class="fields-col" id="${id}"><div class="form-item form-item--phoenix" data-rect="${top},20,600,60">
    <div class="form-item__title"><span class="form-item__text">${label}</span></div>
    <div class="form-item__control"><div class="phoenix-input" data-rect="${top + 24},20,400,32"><input class="phoenix-input__input" type="text" value="${value}"></div></div>
  </div></div>`;
}

// fields: { id: { required, pattern, message } }；linkage: [[开始 id, 结束 id]]，值写成「2019/09」。
function wireForm(doc, fields, { linkage = [] } = {}) {
  const store = {}, shown = [];
  const input = (id) => doc.getElementById(id).querySelector("input");
  const setError = (id, message) => {
    const control = doc.getElementById(id).querySelector(".form-item__control");
    let span = control.querySelector(".form-item__error");
    if (!message) { span?.remove(); return; }
    if (!span) { span = doc.createElement("span"); span.className = "form-item__error"; control.append(span); }
    span.textContent = message;
    shown.push(`${id}:${message}`);
  };
  const validate = (id) => {
    const rule = fields[id] || {}, value = store[id] || "";
    if (rule.required && !value) return "必填";
    if (value && rule.pattern && !new RegExp(rule.pattern).test(value)) return rule.message || "格式校验失败";
    return "";
  };
  const later = (a, b) => {
    const [x, y] = [a, b].map((value) => value.split("/").map(Number));
    const at = x.findIndex((part, index) => part !== y[index]);
    return at >= 0 && x[at] > y[at];
  };
  for (const id of Object.keys(fields)) {
    store[id] = input(id).value;
    input(id).addEventListener("blur", () => {
      store[id] = input(id).value;
      setError(id, validate(id));
      for (const [start, end] of linkage) {
        if (id !== start && id !== end) continue;
        if (store[start] && store[end] && later(store[start], store[end])) setError(id, id === start ? "开始时间必须早于结束时间" : "结束时间必须晚于开始时间");
        else { setError(start, validate(start)); setError(end, validate(end)); }
      }
    });
  }
  return { input, shown, errorOf: (id) => doc.getElementById(id).querySelector(".form-item__error")?.textContent || "" };
}

function selectItem(id, label, top, { selected = "" } = {}) {
  return `<div class="fields-col" id="${id}"><div class="form-item form-item--phoenix" data-rect="${top},20,600,60">
    <div class="form-item__title"><span class="form-item__text">${label}</span></div>
    <div class="form-item__control"><div class="phoenix-select phoenix-select--editable phoenix-select--large" data-rect="${top + 24},20,400,32"><ul class="phoenix-select__content">
      <li class="phoenix-select__selected">${selected}</li>
      <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input phoenix-select__input--large phoenix-select__input--unText"></li>
    </ul></div></div>
  </div></div>`;
}

// rows：列表是虚拟滚动，只画出一屏；loadMs：字典第一次点开时要拉这么久（Infinity：请求失败，加载图标一直转）；
// extra：弹层里另外放的元素。列表为空时写「这里什么都没有...」。
// tree：两级字典（{ 省: [学校] }）：第一屏是省，没有单选圈；搜索结果是学校，名字后面一行写上级名称（div.item-text-fullname）。
// searchMs：搜索交给后台（学校名称）：防抖 400ms 后请求，再过这么久结果才回来；回来之前左侧是上一次的结果（一开始为空）。
function wireSelect(doc, id, { choices = ["汉族", "回族", "满族"], rows = 9, loadMs = 0, extra = "", tree = null, searchMs } = {}) {
  const item = doc.getElementById(id);
  const root = item.querySelector(".phoenix-select");
  const shown = root.querySelector(".phoenix-select__selected");
  const top = Number(item.querySelector(".form-item").getAttribute("data-rect").split(",")[0]);
  const searches = [], events = [];
  // choices 可以在接上之后再往里加（按上一题加载的城市），每次画的时候再读。
  const leaves = () => tree ? Object.entries(tree).flatMap(([parent, names]) => names.map((name) => ({ name, parent }))) : choices.map((name) => ({ name }));
  let loaded = !loadMs;
  root.addEventListener("click", () => {
    if (doc.querySelector(".constant-main-selector-container")) return;
    let word = "", picked = shown.textContent;
    const layer = doc.createElement("div");
    layer.setAttribute("data-rect", `${top + 60},20,560,320`);
    layer.innerHTML = `<div class="common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft"><div class="common-unmodeled-layer__layerContent">
      <div class="constant-main-selector-container"><div class="constant-main-layer-container">${extra}
        <div class="content-search"><div class="phoenix-input"><input class="phoenix-input__input" type="text"></div></div>
        <div class="content-container"><div class="left-container" data-rect="${top + 100},20,280,240"></div>
          <div class="right-container" data-rect="${top + 100},300,260,240"><div><span class="select-data-num">已选<span class="select-data-num-text">0/</span><span class="select-data-num-limit">1</span></span><span class="clear-select-data">清空已选</span></div>
          <div class="select-data-container"></div></div></div>
        <div class="selector-footer-button"><button type="button" class="phoenix-button cancel">取消</button><button type="button" class="phoenix-button ok">确定</button></div>
      </div></div></div></div>`;
    const left = layer.querySelector(".left-container"), right = layer.querySelector(".select-data-container");
    const search = layer.querySelector(".content-search input");
    let results = [], pending = null;
    const chunks = (name) => !word ? `<span>${name}</span>`
      : name.split(word).map((part) => (part ? `<span>${part}</span>` : "")).join(`<mark class="item-label-highLightCls">${word}</mark>`);
    const row = (leaf) => leaf.branch
      ? `<div><div class="list-item-container"><span class="item-text-label"><span>${chunks(leaf.name)}</span></span><svg class="arrow-icon"></svg></div></div>`
      : `<div><div class="list-item-container">`
        + `<span class="icon-container"><svg class="${leaf.name === picked ? "RadioChecked" : "RadioUnchecked"}" data-name="${leaf.name}"></svg></span>`
        + `<span class="item-text-label no-hover"><span>${chunks(leaf.name)}</span></span>`
        + `${word && leaf.parent ? `<div class="item-text-fullname">${leaf.parent}</div>` : ""}</div></div>`;
    const renderLeft = () => {
      if (!loaded) {
        left.innerHTML = `<div class="psd_page-loading psd_page-loading-mask"><div class="psd_page-loading-icon-wrapper"><svg class="psd_page-loading-icon"></svg></div></div>`;
        return;
      }
      const list = !word ? (tree ? Object.keys(tree).map((name) => ({ name, branch: true })) : leaves())
        : searchMs === undefined ? leaves().filter((leaf) => leaf.name.includes(word)) : results;
      const head = word ? `<div class="left-search-result">搜索结果${list.length}个</div>` : `<div class="breadcrumb"><span>全部</span></div>`;
      left.innerHTML = `${head}<div class="list-data-container">${list.length ? list.slice(0, rows).map(row).join("")
        : `<div class="no-data">这里什么都没有...</div>`}</div>`;
    };
    const renderRight = () => {
      layer.querySelector(".select-data-num-text").textContent = picked ? "1/" : "0/";
      right.innerHTML = picked ? `<div class="select-data-item"><span class="select-data-item__name">${picked}</span></div>`
        : `<div class="select-data-empty">请在左侧选择内容</div>`;
    };
    // 点单选圈才勾上；点文字只展开下级。
    left.addEventListener("click", (event) => {
      const radio = event.target.closest?.("svg[data-name]");
      if (!radio) return;
      picked = radio.getAttribute("data-name"); events.push(`radio:${picked}`);
      renderLeft(); renderRight();
    });
    layer.querySelector(".ok").addEventListener("click", () => { events.push("ok"); shown.textContent = picked; close(); });
    layer.querySelector(".cancel").addEventListener("click", () => { events.push("cancel"); close(); });
    search.addEventListener("input", () => {
      searches.push(search.value); word = search.value; renderLeft();
      if (searchMs === undefined) return;
      const asked = word;
      doc.defaultView.clearTimeout(pending);
      pending = doc.defaultView.setTimeout(() => {
        if (asked !== word) return;
        results = leaves().filter((leaf) => leaf.name.includes(asked));
        if (layer.isConnected) renderLeft();
      }, 400 + searchMs);
    });
    // Esc 不管用，点弹层外面才关。
    const outside = (event) => { if (!layer.contains(event.target) && !root.contains(event.target)) close(); };
    const close = () => { layer.remove(); doc.removeEventListener("mousedown", outside, true); };
    doc.addEventListener("mousedown", outside, true);
    renderLeft(); renderRight();
    doc.body.append(layer);
    if (!loaded && Number.isFinite(loadMs)) doc.defaultView.setTimeout(() => { loaded = true; if (layer.isConnected) renderLeft(); }, loadMs);
  });
  return { searches, events, shown: () => shown.textContent };
}

module.exports = { ETHNIC, textItem, wireForm, selectItem, wireSelect };
