// #226 站点配方：把验证有效的深度分析结果存成本机缓存，同类页面再填时先按它找字段，少一次强模型页面分析。
// 配方只记页面结构和操作方法：字段怎么找（插件自己生成的定位信息）、是什么控件、属于哪个分组、
// 填写前要点哪些「编辑 / 展开 / 添加」。不记任何填写值、简历内容、网页正文、完整网址或可执行内容。
// 网址只用来找候选配方；能不能用，要看字段在当前网页上是否能唯一定位（至少 80%，失败不超过 5 个）。
// 这里只放规则和存储，网页、AI 和填写能力由 content.js 注入；后台 background.js 用同一份规则串行写入存储。
(function attachResumeProPageRecipe(scope) {
  const STORAGE_KEY = "fillRecipes:v1";
  const VERSION = 1;
  const MAX_SITES = 200;
  const MAX_RECIPES_PER_SITE = 10;
  const MAX_RECIPE_BYTES = 32 * 1024;
  // 全部配方合计的上限：chrome.storage.local 还要放待同步记录等真正的用户数据，配方只是缓存。
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
  const MAX_FIELDS = 300;
  const MAX_ACTIONS = 5;
  const MAX_SECTIONS = 8;
  const MAX_ORDINAL = 49;
  const MAX_TEXT = 40;
  const MIN_RATIO = 0.8;
  const MAX_FAILED = 5;
  // 命中后更新「最近使用」：一小时内只写一次，避免每次填写都整份重写存储。
  const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
  const MAX_PATH_SEGMENTS = 12;
  const MAX_PATH_CHARS = 256;
  const MAX_SEGMENT_CHARS = 64;
  const DOM_KINDS = new Set(["text", "textarea", "native-select", "radio", "checkbox", "date", "custom-select", "cascader"]);
  const FILL_CONTROLS = new Set(["text", "textarea", "native-select", "radio", "checkbox", "date", "custom-select", "cascader"]);
  const DOMAINS = new Set(["education", "work", "projects", "papers"]);
  const TIERS = new Set(["strong", "default", ""]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // 「请输入」「请选择」这类占位文字每个框都一样，只能加分，不能单独当作找到字段的依据。
  const GENERIC_PLACEHOLDER = /^(?:请)?(?:输入|选择|填写|选取)(?:内容)?$|^(?:please)?(?:enter|select|input|choose)$|^(?:搜索|search)$/i;
  // 组件库、框架自动生成的 id / name（每次渲染都可能变）。
  const GENERATED_TOKEN = /^(?:rc[_-]|el-(?:id|popper|select|tooltip|collapse|tabs|input|form-item)-|react-select-|mui-|headlessui-|radix-|ember\d|ext-gen|yui_|ui-id-|jsx-|css-|sc-|uid-|__)/i;
  const WEIGHTS = { t: 8, n: 6, i: 6, a: 4, c: 3, p: 2 };

  const outlineApi = () => scope.ResumeProPageOutline || (typeof require === "function" ? require("./page-outline.js") : null);
  const deepApi = () => scope.ResumeProDeepAnalysis || (typeof require === "function" ? require("./deep-analysis.js") : null);
  const plainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const squash = text => String(text ?? "").replace(/\s+/g, " ").trim();
  const bare = text => String(text ?? "").replace(/[\s\p{P}\p{S}\p{Co}\p{M}\p{Cf}]/gu, "");
  const encodedBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  // 比较用：统一全角半角、去空白、小写，去掉必填星号和冒号。
  const norm = text => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase().replace(/^[*＊]+|[*＊:：]+$/g, "");
  // 分组标题里的序号（教育经历 1、教育经历 2）不作区分：同类条目靠下面的组内序号分开。
  const normSection = text => norm(text).replace(/[0-9一二三四五六七八九十]+/g, "#");

  // ---- 网页归类 ---------------------------------------------------------------

  // 网址 → { host, path }。路径里 3 位以上的纯数字段、UUID 段、16 位以上的十六进制段换成 *，去掉查询参数和 # 后面的部分。
  // 去掉之后剩下的路径段仍可能带个人信息（邮箱、手机号、和简历重叠的文字、像令牌的长串）：说不清的一律不归类，不保存。
  // redact：可选，大纲同一套脱敏（带简历值）；保存前必须带上，读取时可以不带。
  function pageKey(href, { redact } = {}) {
    let url;
    try {
      url = new URL(String(href || ""));
    } catch {
      return { ok: false, reason: "unsupported" };
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return { ok: false, reason: "unsupported" };
    const host = url.hostname.toLowerCase();
    if (!validHost(host)) return { ok: false, reason: "unsupported" };
    const raw = url.pathname.split("/").filter(Boolean);
    if (raw.length > MAX_PATH_SEGMENTS) return { ok: false, reason: "path_unsafe" };
    const segments = [];
    for (const piece of raw) {
      let segment;
      try {
        segment = decodeURIComponent(piece);
      } catch {
        return { ok: false, reason: "path_unsafe" };
      }
      if (/^\d{3,}$/.test(segment) || UUID.test(segment) || /^[0-9a-f]{16,}$/i.test(segment)) {
        segments.push("*");
        continue;
      }
      if (!segment || segment.length > MAX_SEGMENT_CHARS || /[\s/\\?#*]/.test(segment) || !safeText(segment, redact)) {
        return { ok: false, reason: "path_unsafe" };
      }
      segments.push(segment);
    }
    const path = `/${segments.join("/")}`;
    if (path.length > MAX_PATH_CHARS) return { ok: false, reason: "path_unsafe" };
    return { ok: true, host, path };
  }

  function validHost(host) {
    return typeof host === "string" && host.length <= 253 && /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(host);
  }
  function validPath(path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_PATH_CHARS) return false;
    const segments = path.slice(1).split("/").filter(Boolean);
    if (segments.length > MAX_PATH_SEGMENTS || (path !== "/" && path.slice(1).split("/").some(segment => !segment))) return false;
    return segments.every(segment => segment === "*" || (segment.length <= MAX_SEGMENT_CHARS && !/[\s/\\?#*]/.test(segment) && safeText(segment)));
  }

  // 可以写进配方的文字：不像联系方式、证件号、网址、凭据，也不和简历内容重叠（有 redact 时）。
  function safeText(text, redact) {
    const value = squash(text);
    if (!value) return true;
    const outline = outlineApi();
    if (!outline) return false;
    if (value.includes(outline.REDACTED) || outline.sensitiveShape(value)) return false;
    if (redact && redact(value, 400) !== value) return false;
    return true;
  }

  // ---- 定位信息（插件生成，不由模型生成） ---------------------------------------

  const attr = (el, name) => String(el?.getAttribute?.(name) ?? "");

  // 看起来稳定的 id / name：不含 4 位以上连续数字，不像哈希或组件库自动生成的写法。
  function stableToken(value) {
    const token = String(value ?? "").trim();
    if (!token || token.length > 64 || /\s/.test(token) || token.includes(":")) return "";
    if (/\d{4,}/.test(token) || GENERATED_TOKEN.test(token)) return "";
    const parts = token.split(/[-_.[\]]+/).filter(Boolean);
    if (parts.some(part => part.length >= 8 && /^[0-9a-f]+$/i.test(part) && /\d/.test(part))) return "";
    if (parts.some(part => part.length >= 10 && /[a-z]/i.test(part) && (part.match(/\d/g) || []).length >= 3)) return "";
    return token;
  }

  // 元素所在的作用域：开放 Shadow DOM 的宿主、同源框架，一层层往外记，主文档是空串。
  // 只记标签名和稳定的 id / name，配不上就不算同一个作用域（不跨作用域找字段）。
  function scopeKey(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const root = node.getRootNode?.();
      if (root && root.host && root !== node.ownerDocument) {
        const host = root.host;
        const id = stableToken(host.id);
        parts.push(`s:${String(host.tagName || "").toLowerCase()}${id ? `#${id}` : ""}`);
        node = host;
        continue;
      }
      let frame = null;
      try {
        frame = (node.ownerDocument || root)?.defaultView?.frameElement || null;
      } catch {
        frame = null;
      }
      if (!frame) break;
      const label = frameLabel(frame);
      const peers = Array.from(frame.ownerDocument?.querySelectorAll?.("iframe, frame") || []).filter(other => frameLabel(other) === label);
      parts.push(`f:${label}:${Math.max(0, peers.indexOf(frame))}`);
      node = frame;
    }
    return parts.reverse().join(">");
  }
  function frameLabel(frame) {
    const id = stableToken(frame.id);
    const name = stableToken(attr(frame, "name"));
    return `${String(frame.tagName || "").toLowerCase()}${id ? `#${id}` : name ? `[${name}]` : ""}`;
  }

  // 一段网页文字能不能写进定位信息：同一套脱敏后原样保留的才要；被换成「〔内容〕」的、像个人信息的一律丢掉。
  function cleaner(redact) {
    const outline = outlineApi();
    return text => {
      const value = squash(text);
      if (!value) return "";
      const shown = redact ? redact(value, MAX_TEXT) : value.slice(0, MAX_TEXT);
      return !shown || shown.includes(outline.REDACTED) || outline.sensitiveShape(shown) ? "" : shown;
    };
  }

  function controlDescriptor(node, ref, outline, clean) {
    const el = node.element;
    return {
      s: scopeKey(el),
      k: node.domKind,
      // 分组：字段扫描给每个控件找的所属区块（同一条记录里的题目一致）；找不到时用大纲的区块标题。
      // 大纲的区块标题在一条记录的第一题上常常还是上一级标题，不能直接当分组用。
      sec: clean(node.control?.section || outline.titles?.get(ref) || ""),
      t: clean(node.control?.label || ""),
      c: clean(outline.clues?.get(ref) || ""),
      n: clean(stableToken(attr(el, "name"))),
      i: clean(stableToken(el?.id)),
      a: clean(attr(el, "aria-label")),
      p: clean(attr(el, "placeholder")),
      lib: outlineApi().libraryOf?.(node.root || el) || "",
      sh: node.shape || ""
    };
  }

  const descriptorKey = loc => ["t", "c", "n", "i", "a", "p"].map(key => norm(loc[key])).join("\u0001");
  const bucketKey = loc => `${loc.s || ""}\u0001${loc.k}\u0001${normSection(loc.sec)}`;
  const genericPlaceholder = text => GENERIC_PLACEHOLDER.test(bare(text).toLowerCase());
  // 至少要有一条能说明「是哪一题」的依据；只有通用占位文字、只有序号的不算。
  const hasAnchor = loc => Boolean(loc.t || loc.n || loc.i || loc.a || loc.c || (loc.p && !genericPlaceholder(loc.p)));

  // 当前网页上可以按配方填写的控件，按文档顺序。
  function controlCandidates(outline, clean) {
    const list = [];
    for (const [ref, node] of outline.nodes) {
      if (node?.type !== "control" || !DOM_KINDS.has(node.domKind) || !node.element || node.element.isConnected === false) continue;
      if (node.control?.disabled) continue;
      const loc = controlDescriptor(node, ref, outline, clean);
      list.push({ ref, node, loc, key: descriptorKey(loc), bucket: bucketKey(loc) });
    }
    return list;
  }

  function buttonCandidates(outline, clean) {
    const list = [];
    for (const [ref, node] of outline.nodes) {
      if (node?.type !== "button" || !node.element || node.element.isConnected === false) continue;
      const loc = { s: scopeKey(node.element), sec: clean(outline.titles?.get(ref) || ""), t: clean(node.text || "") };
      list.push({ ref, node, loc, bucket: `${loc.s}\u0001${normSection(loc.sec)}\u0001${bare(loc.t).toLowerCase()}` });
    }
    return list;
  }

  // 一个配方字段和一个候选的得分；有冲突（题目、name、id、aria-label 两边都有却不一样）返回 -1。
  function score(saved, cand) {
    for (const key of ["t", "n", "i", "a"]) {
      if (saved[key] && cand[key] && norm(saved[key]) !== norm(cand[key])) return -1;
    }
    // 配方里有题目、网页上这个控件却没有题目了：结构已经变了。
    if (saved.t && !cand.t) return -1;
    let total = 0;
    let anchored = false;
    for (const key of ["t", "n", "i", "a", "c"]) {
      if (saved[key] && cand[key] && norm(saved[key]) === norm(cand[key])) {
        total += WEIGHTS[key];
        anchored = true;
      }
    }
    if (saved.p && cand.p && norm(saved.p) === norm(cand.p)) {
      if (genericPlaceholder(saved.p)) total += 0.5;
      else { total += WEIGHTS.p; anchored = true; }
    }
    if (!anchored) return -1;
    if (saved.lib && saved.lib === cand.lib) total += 0.25;
    if (saved.sh && saved.sh === cand.sh) total += 0.25;
    return total;
  }

  // 同作用域、同控件类型、同分组里得分最高的候选。exclude：这次刚新增的条目，不和已保存的字段抢。
  function topCandidates(saved, buckets, exclude = null) {
    const pool = buckets.get(bucketKey(saved)) || [];
    let best = -1;
    let top = [];
    for (const cand of pool) {
      if (exclude?.(cand)) continue;
      const value = score(saved, cand.loc);
      if (value < 0) continue;
      if (value > best) { best = value; top = [cand]; }
      else if (value === best) top.push(cand);
    }
    if (!top.length) return { reason: "missing", top };
    // 分数一样、特征却不同：说不清是哪一个。
    if (top.some(cand => cand.key !== top[0].key)) return { reason: "ambiguous", top: [] };
    return { reason: "", top };
  }

  // 找一个配方字段：只有唯一的最佳候选才算找到。保存时这一题就在几条结构相同的记录里重复出现（m 条）的，
  // 按保存时的组内序号取，序号超出就算没找到；保存时只有一个、现在却出现了同名的，不猜。
  function bestMatch(saved, buckets, exclude = null) {
    const { reason, top } = topCandidates(saved, buckets, exclude);
    if (reason) return { reason };
    if (!saved.m) return top.length === 1 ? { cand: top[0], tied: top } : { reason: "ambiguous" };
    const ordinal = saved.o || 0;
    if (ordinal >= top.length) return { reason: "missing", tied: top };
    return { cand: top[ordinal], tied: top };
  }

  function bucketsOf(list) {
    const buckets = new Map();
    for (const cand of list) {
      if (!buckets.has(cand.bucket)) buckets.set(cand.bucket, []);
      buckets.get(cand.bucket).push(cand);
    }
    return buckets;
  }

  // 结构指纹：字段（控件类型 + 脱敏后的题目文字 + 分组）和动作排序后的哈希。只用来在诊断里说明结构有没有变化，
  // 是否可用仍以实际定位为准。不含任何填写值。
  function fingerprint(fields, actions = []) {
    const lines = [
      ...fields.map(loc => `${loc.k}|${norm(loc.t || loc.c || loc.n || loc.a || loc.p)}|${normSection(loc.sec)}`),
      ...actions.map(item => `${item.kind}|${bare(item.btn?.t).toLowerCase()}|${normSection(item.btn?.sec)}`)
    ].sort();
    return hash64(lines.join("\n"));
  }
  function hash64(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (const char of String(text)) {
      const code = char.codePointAt(0);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
      b = (b ^ (b >>> 13)) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }

  // ---- 生成配方 ---------------------------------------------------------------

  // 用户确认的「编辑 / 展开」→ 按钮定位信息。要在点击之前生成：很多网页点完「编辑」按钮就换掉了。
  // 有一个说不清就返回 null（这份分析不存成配方）。
  function actionLocators(items, outline) {
    const deep = deepApi();
    const clean = cleaner(outline.redact);
    const list = [];
    for (const item of items || []) {
      if (!["edit", "expand"].includes(item.kind)) continue;
      const btn = buttonLocator(item.ref, outline, clean, deep.ALLOW[item.kind]);
      if (!btn) return null;
      list.push({ kind: item.kind, btn });
    }
    return list.slice(0, MAX_ACTIONS);
  }

  // 深度分析填写之前，把这次实际要用的说明书变成配方草稿（填写可能让网页重画，先按填写前的样子记）。
  // fields：最后一轮校验过的说明书字段；outline：这一轮的大纲；sections：最后一轮的经历分组；
  // actions：actionLocators() 在点击前生成的按钮定位；tier：分析实际用的档位。
  // 定位不了（没有任何可靠依据）的字段不进配方；能找回的不到 80% 就不保存。
  function buildRecipe({ fields, outline, sections = [], actions = null, tier = "", now = Date.now() }) {
    const deep = deepApi();
    const clean = cleaner(outline.redact);
    const candidates = controlCandidates(outline, clean);
    const byRef = new Map(candidates.map(cand => [cand.ref, cand]));
    const buckets = bucketsOf(candidates);
    let dropped = 0;
    let eligible = 0;
    const kept = [];
    const used = new Set();
    for (const field of (fields || []).slice(0, MAX_FIELDS)) {
      const cand = byRef.get(field.ref);
      // 富文本框、暂不支持的控件这次本来就没填，不算在内。
      if (!cand || !FILL_CONTROLS.has(field.control)) continue;
      eligible += 1;
      if (used.has(cand.node.element) || !hasAnchor(cand.loc)) { dropped += 1; continue; }
      const label = clean(field.label || "");
      if (!label && !cand.loc.t) { dropped += 1; continue; }
      const loc = { ...cand.loc };
      const same = (buckets.get(cand.bucket) || []).filter(other => other.key === cand.key);
      const ordinal = same.indexOf(cand);
      if (ordinal > MAX_ORDINAL || same.length > MAX_ORDINAL + 1) { dropped += 1; continue; }
      if (same.length > 1) {
        loc.m = same.length;
        if (ordinal > 0) loc.o = ordinal;
      }
      // 用当前大纲自己核对一遍：存下的定位信息必须正好找回这个控件。
      const check = bestMatch(loc, buckets);
      if (check.cand !== cand) { dropped += 1; continue; }
      used.add(cand.node.element);
      kept.push(compact({ loc: compact(loc), control: field.control, label, group: clean(field.group || ""),
        gi: Number.isInteger(field.groupIndex) ? field.groupIndex : undefined, hints: deep.cleanHints(field.hints) }));
    }
    // 下次能重新找到的字段太少（不到这次的 80%）：按配方填会比这次差，不保存。
    if (!kept.length || kept.length / eligible < MIN_RATIO) return { ok: false, reason: "no_locatable_fields", dropped };

    const savedActions = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];
    const savedSections = [];
    for (const section of sections.filter(item => item.addRef).slice(0, MAX_SECTIONS)) {
      const add = buttonLocator(section.addRef, outline, clean, deep.ALLOW.add);
      if (!add) { dropped += 1; continue; }
      let row = null;
      if (section.rowRefs?.length) {
        row = rowLocator(section.rowRefs, byRef, buckets);
        // 已有条目说不清怎么数：这个分组不进配方（下次也不会凭它新增）。
        if (!row) { dropped += 1; continue; }
      }
      savedSections.push({ domain: section.domain, add, ...(row ? { row } : {}) });
    }
    const recipe = {
      v: VERSION, created: now, updated: now, used: now, tier: TIERS.has(tier) ? tier : "",
      fp: fingerprint(kept.map(field => field.loc), savedActions),
      fields: kept, ...(savedActions.length ? { actions: savedActions } : {}), ...(savedSections.length ? { sections: savedSections } : {})
    };
    // 保存前再查一遍全部要存的文字（含简历重叠）：有一处说不清就整份不存。
    if (!recipeTextSafe(recipe, outline.redact)) return { ok: false, reason: "privacy", dropped };
    const clean2 = sanitizeRecipe(recipe);
    if (!clean2) return { ok: false, reason: "invalid", dropped };
    if (encodedBytes(clean2) > MAX_RECIPE_BYTES) return { ok: false, reason: "too_large", dropped };
    return { ok: true, recipe: clean2, dropped };
  }

  // 按钮的定位：作用域、分组、按钮文字，以及同一分组里同样文字的按钮的序号和个数（个数变了就不认）。
  function buttonLocator(ref, outline, clean, allow) {
    const node = outline?.nodes?.get(ref);
    if (!node || node.type !== "button") return null;
    const deep = deepApi();
    if (!deep.buttonAllowed(node, allow)) return null;
    const list = buttonCandidates(outline, clean);
    const cand = list.find(item => item.ref === ref);
    if (!cand || !cand.loc.t) return null;
    const same = list.filter(item => item.bucket === cand.bucket);
    const ordinal = same.indexOf(cand);
    if (ordinal < 0 || ordinal > MAX_ORDINAL || same.length > MAX_ORDINAL + 1) return null;
    return compact({ s: cand.loc.s, sec: cand.loc.sec, t: cand.loc.t, o: ordinal || undefined, n: same.length });
  }

  // 已有条目的定位：每条记录取一个输入框（说明书的 rowRefs）。这些输入框必须是同一题、彼此完全一样，
  // 并且按定位信息在网页上正好找回这几个，下次才能用同一条定位信息数出当前有几条。
  function rowLocator(rowRefs, byRef, buckets) {
    const cands = rowRefs.map(ref => byRef.get(ref));
    if (cands.some(cand => !cand) || !hasAnchor(cands[0].loc)) return null;
    if (cands.some(cand => cand.bucket !== cands[0].bucket || cand.key !== cands[0].key)) return null;
    const found = rowsOf(cands[0].loc, buckets);
    if (!found || found.length !== cands.length || !cands.every(cand => found.includes(cand))) return null;
    const { o, m, ...loc } = cands[0].loc;
    return compact(loc);
  }
  // 同一题在几条记录里各出现一次：全部候选就是当前的每一条。
  function rowsOf(loc, buckets) {
    const { reason, top } = topCandidates(loc, buckets);
    return reason === "ambiguous" ? null : top;
  }

  function compact(object) {
    const out = {};
    for (const [key, value] of Object.entries(object)) {
      if (value === undefined || value === "" || value === null) continue;
      if (plainObject(value) && !Object.keys(value).length) continue;
      out[key] = value;
    }
    return out;
  }

  function recipeTextSafe(recipe, redact) {
    const texts = [];
    const walk = value => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (plainObject(value)) Object.entries(value).forEach(([key, item]) => { if (!["fp", "k", "control", "kind", "domain", "tier", "lib", "sh"].includes(key)) walk(item); });
    };
    walk(recipe);
    return texts.every(text => text.split(">").every(piece => safeText(piece, redact)));
  }

  // ---- 配方格式校验（读取、写入都过一遍） -------------------------------------

  const LOC_TEXT_KEYS = ["sec", "t", "c", "n", "i", "a", "p"];
  function cleanLocator(raw, { field = true } = {}) {
    if (!plainObject(raw)) return null;
    const loc = {};
    if (raw.s !== undefined && (typeof raw.s !== "string" || raw.s.length > 160 || /\s/.test(raw.s))) return null;
    if (raw.s) loc.s = raw.s;
    if (field) {
      if (!DOM_KINDS.has(raw.k)) return null;
      loc.k = raw.k;
    }
    for (const key of field ? LOC_TEXT_KEYS : ["sec", "t"]) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== "string" || Array.from(raw[key]).length > MAX_TEXT || !safeText(raw[key])) return null;
      if (raw[key]) loc[key] = raw[key];
    }
    if (field) {
      if (raw.lib !== undefined) { if (!/^[a-z]{1,12}$/.test(raw.lib)) return null; loc.lib = raw.lib; }
      if (raw.sh !== undefined) { if (!["下拉", "级联", "日期"].includes(raw.sh)) return null; loc.sh = raw.sh; }
      if (!hasAnchor({ s: "", ...loc })) return null;
    } else {
      if (!loc.t) return null;
      if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > MAX_ORDINAL + 1) return null;
      loc.n = raw.n;
    }
    if (raw.o !== undefined) {
      if (!Number.isInteger(raw.o) || raw.o < 0 || raw.o > MAX_ORDINAL || (!field && raw.o >= raw.n)) return null;
      if (raw.o) loc.o = raw.o;
    }
    if (field && raw.m !== undefined) {
      if (!Number.isInteger(raw.m) || raw.m < 2 || raw.m > MAX_ORDINAL + 1 || (loc.o || 0) >= raw.m) return null;
      loc.m = raw.m;
    }
    if (field && loc.o && !loc.m) return null;
    if (!loc.s) loc.s = "";
    return loc;
  }

  const timestamp = value => Number.isSafeInteger(value) && value > 0;
  function sanitizeRecipe(raw) {
    if (!plainObject(raw) || raw.v !== VERSION) return null;
    if (!timestamp(raw.created) || !timestamp(raw.updated) || !timestamp(raw.used)) return null;
    if (typeof raw.fp !== "string" || !/^[0-9a-f]{16}$/.test(raw.fp)) return null;
    if (raw.tier !== undefined && !TIERS.has(raw.tier)) return null;
    if (!Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > MAX_FIELDS) return null;
    const deep = deepApi();
    const fields = [];
    for (const item of raw.fields) {
      if (!plainObject(item) || !FILL_CONTROLS.has(item.control)) return null;
      const loc = cleanLocator(item.loc);
      if (!loc) return null;
      const field = { loc, control: item.control };
      for (const key of ["label", "group"]) {
        if (item[key] === undefined) continue;
        if (typeof item[key] !== "string" || Array.from(item[key]).length > MAX_TEXT || !safeText(item[key])) return null;
        if (item[key]) field[key] = item[key];
      }
      if (!field.label && !loc.t) return null;
      if (item.gi !== undefined) {
        if (!Number.isInteger(item.gi) || item.gi < 1 || item.gi > 50) return null;
        field.gi = item.gi;
      }
      const hints = deep.cleanHints(item.hints);
      if (Object.keys(hints).length) field.hints = hints;
      fields.push(field);
    }
    const recipe = { v: VERSION, created: raw.created, updated: raw.updated, used: raw.used, tier: raw.tier || "", fp: raw.fp, fields };
    if (raw.actions !== undefined) {
      if (!Array.isArray(raw.actions) || raw.actions.length > MAX_ACTIONS) return null;
      const actions = [];
      for (const item of raw.actions) {
        if (!plainObject(item) || !["edit", "expand"].includes(item.kind)) return null;
        const btn = cleanLocator(item.btn, { field: false });
        if (!btn || !allowedText(btn.t, deep.ALLOW[item.kind])) return null;
        actions.push({ kind: item.kind, btn });
      }
      if (actions.length) recipe.actions = actions;
    }
    if (raw.sections !== undefined) {
      if (!Array.isArray(raw.sections) || raw.sections.length > MAX_SECTIONS) return null;
      const sections = [];
      for (const item of raw.sections) {
        if (!plainObject(item) || !DOMAINS.has(item.domain)) return null;
        const add = cleanLocator(item.add, { field: false });
        if (!add || !allowedText(add.t, deep.ALLOW.add)) return null;
        let row = null;
        if (item.row !== undefined) {
          row = cleanLocator(item.row);
          if (!row) return null;
        }
        sections.push({ domain: item.domain, add, ...(row ? { row } : {}) });
      }
      if (sections.length) recipe.sections = sections;
    }
    return recipe;
  }
  function allowedText(text, allow) {
    const value = bare(text);
    return Boolean(value) && !deepApi().DENY.test(value) && allow.test(value);
  }

  // ---- 用配方定位 -------------------------------------------------------------

  // 在当前大纲里找配方的全部字段。extraScopes：这次刚新增的条目（page-actions 返回的 scopes），
  // 新条目里和已保存字段完全一样的输入框按同一题补上（组内序号顺延），已有条目不受影响。
  // 返回 { ok, total, located, failed, missing, ambiguous, entries, sameStructure }。
  function locateFields(recipe, outline, { extraScopes = [] } = {}) {
    const clean = cleaner(outline.redact);
    const candidates = controlCandidates(outline, clean);
    const buckets = bucketsOf(candidates);
    const fresh = cand => extraScopes.some(root => root?.contains?.(cand.node.element));
    // 这次刚新增了条目时：保存时就重复出现的题目按文档顺序（已有条目在前、新条目在后）取第几个；
    // 保存时只出现一次的题目先在已有条目里找，已有条目里没有（保存时那条也是新增的）才取第一条新条目。
    const matchOne = loc => {
      if (!extraScopes.length || loc.m) return bestMatch(loc, buckets);
      const old = bestMatch(loc, buckets, fresh);
      if (old.cand || old.reason === "ambiguous") return old;
      const { reason, top } = topCandidates(loc, buckets, cand => !fresh(cand));
      return reason || !top.length ? old : { cand: top[0], tied: top };
    };
    const results = recipe.fields.map(field => ({ field, ...matchOne(field.loc) }));
    // 两个配方字段落到同一个控件上：两个都不算找到（同一个控件不能填两次）。
    const claims = new Map();
    for (const result of results) {
      if (!result.cand) continue;
      claims.set(result.cand, (claims.get(result.cand) || 0) + 1);
    }
    let missing = 0;
    let ambiguous = 0;
    const entries = [];
    for (const result of results) {
      if (!result.cand) {
        if (result.reason === "ambiguous") ambiguous += 1;
        else missing += 1;
        continue;
      }
      if (claims.get(result.cand) > 1) { ambiguous += 1; continue; }
      entries.push({ field: result.field, ref: result.cand.ref, node: result.cand.node, loc: result.cand.loc });
    }
    const total = recipe.fields.length;
    const located = entries.length;
    const failed = total - located;
    const ok = total > 0 && located / total >= MIN_RATIO && failed <= MAX_FAILED;
    let extra = 0;
    if (ok && extraScopes.length) {
      const claimed = new Set(entries.map(entry => entry.node.element));
      const groups = new Map();
      for (const result of results) {
        if (!result.cand || claims.get(result.cand) > 1 || !result.tied) continue;
        const key = result.tied[0];
        if (!groups.has(key)) groups.set(key, { loc: result.field.loc, fields: [] });
        groups.get(key).fields.push(result.field);
      }
      for (const { loc, fields } of groups.values()) {
        const template = fields.reduce((last, field) => ((field.gi || 0) >= (last.gi || 0) ? field : last), fields[0]);
        // 新条目里和这一题完全一样的输入框（同一套打分，只看新条目）。
        const { reason, top } = topCandidates(loc, buckets, cand => !fresh(cand));
        if (reason) continue;
        let step = 0;
        for (const cand of top) {
          if (claimed.has(cand.node.element)) continue;
          step += 1;
          claimed.add(cand.node.element);
          entries.push({ field: { ...template, ...(template.gi ? { gi: Math.min(50, template.gi + step) } : {}) }, ref: cand.ref, node: cand.node, loc: cand.loc, extra: true });
          extra += 1;
        }
      }
    }
    const sameStructure = ok ? fingerprint(entries.filter(entry => !entry.extra).map(entry => entry.loc), recipe.actions || []) === recipe.fp : false;
    return { ok, total, located, failed, missing, ambiguous, extra, entries, sameStructure };
  }

  // 配方字段 → 和说明书同形的字段，交给 deep-analysis.js 的 toFillInput（再走普通填写流程）。
  function toSpecFields(entries) {
    return entries.map(entry => ({
      ref: entry.ref,
      label: entry.field.label || entry.loc.t || "",
      group: entry.field.group || "",
      groupIndex: Number.isInteger(entry.field.gi) ? entry.field.gi : null,
      control: entry.field.control,
      hints: entry.field.hints || {}
    }));
  }

  // 在当前大纲里找配方的「编辑 / 展开」和经历分组的「添加」。动作执行前能核对的只有这些按钮：
  // 每个都要唯一找到、文字仍在允许列表里，同样文字的按钮个数也和保存时一样，否则整份不用（不猜）。
  // 返回 { ok, preActions: [{ ref, kind }], sections: [{ domain, addRef, rowRefs }], reason }。
  function locateActions(recipe, outline) {
    const deep = deepApi();
    const clean = cleaner(outline.redact);
    const buttons = buttonCandidates(outline, clean);
    const find = (btn, allow) => {
      const bucket = `${btn.s || ""}\u0001${normSection(btn.sec)}\u0001${bare(btn.t).toLowerCase()}`;
      const same = buttons.filter(item => item.bucket === bucket);
      if (same.length !== btn.n) return null;
      const cand = same[btn.o || 0];
      return cand && deep.buttonAllowed(cand.node, allow) ? cand : null;
    };
    const preActions = [];
    for (const action of recipe.actions || []) {
      const cand = find(action.btn, deep.ALLOW[action.kind]);
      if (!cand || preActions.some(item => item.ref === cand.ref)) return { ok: false, reason: "action_missing", preActions: [], sections: [] };
      preActions.push({ ref: cand.ref, kind: action.kind });
    }
    const sections = [];
    const candidates = recipe.sections?.length ? controlCandidates(outline, clean) : [];
    const buckets = bucketsOf(candidates);
    for (const section of recipe.sections || []) {
      const cand = find(section.add, deep.ALLOW.add);
      if (!cand) continue;
      let rowRefs = [];
      if (section.row) {
        const rows = rowsOf(section.row, buckets);
        // 一条都找不到时按「没有条目」交给 form-agent：它会核对分组里确实没有输入框，有就不新增。
        rowRefs = rows ? rows.map(row => row.ref) : [];
      }
      sections.push({ domain: section.domain, addRef: cand.ref, rowRefs });
    }
    return { ok: true, preActions, sections };
  }

  // ---- 保存条件 ---------------------------------------------------------------

  // 深度分析结束后要不要存：校验通过、没有取消或停止、核验后的填写数比同一页面上一次普通填写多。
  // baseline：{ filled }（同一页面、同一次打开里的普通填写结果；普通扫描一个字段都没有时为 0）；没有就不比、不存。
  function saveDecision({ validation, result, baseline, stopped = false }) {
    if (validation !== "通过") return { save: false, reason: "invalid" };
    if (stopped || !result || result.overwriteDeclined) return { save: false, reason: "cancelled" };
    if (!["success", "partial"].includes(result.outcome)) return { save: false, reason: "failed" };
    const filled = Number(result.filledCount) || 0;
    if (filled <= 0) return { save: false, reason: "nothing_filled" };
    if (!baseline || !Number.isInteger(baseline.filled) || baseline.filled < 0) return { save: false, reason: "no_baseline" };
    if (filled <= baseline.filled) return { save: false, reason: "not_better" };
    return { save: true, reason: "" };
  }

  // ---- 存储 -------------------------------------------------------------------

  const emptyStore = () => ({ v: VERSION, sites: {} });

  // 读出整份存储并逐条校验：不认识的版本整份不用（也不覆盖），坏掉的条目丢掉。
  // status：empty / ok / partial（丢了坏条目）/ corrupt（整份坏了）/ unsupported（更新版本写的）。
  function readStore(raw) {
    if (raw === undefined || raw === null) return { status: "empty", store: emptyStore() };
    if (!plainObject(raw)) return { status: "corrupt", store: emptyStore() };
    if (raw.v !== VERSION) {
      return { status: Number.isInteger(raw.v) && raw.v > VERSION ? "unsupported" : "corrupt", store: emptyStore() };
    }
    if (!plainObject(raw.sites)) return { status: "corrupt", store: emptyStore() };
    const store = emptyStore();
    let dropped = 0;
    for (const [host, site] of Object.entries(raw.sites)) {
      if (!validHost(host) || !plainObject(site)) { dropped += 1; continue; }
      const recipes = {};
      for (const [path, recipe] of Object.entries(site)) {
        const clean = validPath(path) ? sanitizeRecipe(recipe) : null;
        if (!clean || encodedBytes(clean) > MAX_RECIPE_BYTES) { dropped += 1; continue; }
        recipes[path] = clean;
      }
      if (Object.keys(recipes).length) store.sites[host] = recipes;
    }
    return { status: dropped ? "partial" : "ok", store, dropped };
  }

  // 只取一条：一键填写和侧栏状态不需要校验整份存储。版本不对、格式不对都当作没有。
  function lookup(raw, key) {
    if (!key?.ok || !plainObject(raw) || raw.v !== VERSION || !plainObject(raw.sites)) return null;
    if (!Object.prototype.hasOwnProperty.call(raw.sites, key.host)) return null;
    const site = raw.sites[key.host];
    if (!plainObject(site) || !Object.prototype.hasOwnProperty.call(site, key.path)) return null;
    const recipe = sanitizeRecipe(site[key.path]);
    return recipe && encodedBytes(recipe) <= MAX_RECIPE_BYTES ? recipe : null;
  }

  function findRecipe(store, key) {
    if (!key?.ok) return null;
    return store?.sites?.[key.host]?.[key.path] || null;
  }

  const siteUsed = site => Math.max(0, ...Object.values(site).map(recipe => recipe.used || 0));
  function leastUsedHost(store, keep) {
    let pick = null;
    for (const [host, site] of Object.entries(store.sites)) {
      if (host === keep) continue;
      if (!pick || siteUsed(site) < siteUsed(store.sites[pick])) pick = host;
    }
    return pick;
  }

  // 写入一条配方，并按最久未用淘汰：同一网站最多 10 条，最多 200 个网站，全部合计不超过 2 MB。
  function upsert(store, host, path, recipe, now) {
    if (!validHost(host) || !validPath(path)) return { ok: false, error: "invalid_key" };
    const next = JSON.parse(JSON.stringify(store));
    const previous = next.sites[host]?.[path];
    const clean = sanitizeRecipe({ ...recipe, created: previous?.created || recipe.created || now, updated: now, used: now });
    if (!clean) return { ok: false, error: "invalid" };
    if (encodedBytes(clean) > MAX_RECIPE_BYTES) return { ok: false, error: "too_large" };
    const site = next.sites[host] || {};
    site[path] = clean;
    next.sites[host] = site;
    let evicted = 0;
    while (Object.keys(site).length > MAX_RECIPES_PER_SITE) {
      const oldest = Object.entries(site).filter(([other]) => other !== path).sort((a, b) => a[1].used - b[1].used)[0][0];
      delete site[oldest];
      evicted += 1;
    }
    while (Object.keys(next.sites).length > MAX_SITES) {
      delete next.sites[leastUsedHost(next, host)];
      evicted += 1;
    }
    while (encodedBytes(next) > MAX_TOTAL_BYTES) {
      const host2 = leastUsedHost(next, host);
      if (host2) { delete next.sites[host2]; evicted += 1; continue; }
      const others = Object.entries(site).filter(([other]) => other !== path).sort((a, b) => a[1].used - b[1].used);
      if (!others.length) return { ok: false, error: "too_large" };
      delete site[others[0][0]];
      evicted += 1;
    }
    return { ok: true, store: next, evicted };
  }

  function removeRecipe(store, host, path) {
    if (!store.sites[host]?.[path]) return { ok: true, store, removed: false };
    const next = JSON.parse(JSON.stringify(store));
    delete next.sites[host][path];
    if (!Object.keys(next.sites[host]).length) delete next.sites[host];
    return { ok: true, store: next, removed: true };
  }

  function touchRecipe(store, host, path, now) {
    const recipe = store.sites[host]?.[path];
    if (!recipe || now - recipe.used < TOUCH_INTERVAL_MS) return { ok: true, store, changed: false };
    const next = JSON.parse(JSON.stringify(store));
    next.sites[host][path].used = now;
    return { ok: true, store: next, changed: true };
  }

  // 串行读写：所有修改排成一队，一次保存或删除不会覆盖别的网页同时写入的其他网站配方。
  // area 是 chrome.storage.local（或测试替身）。写失败时原来的存储保持不变，结果如实返回失败。
  function createStore(area, { now = () => Date.now() } = {}) {
    let chain = Promise.resolve();
    const queue = task => {
      const next = chain.then(task, task);
      chain = next.catch(() => {});
      return next;
    };
    async function load() {
      const got = await area.get([STORAGE_KEY]);
      return readStore(got?.[STORAGE_KEY]);
    }
    const mutate = change => queue(async () => {
      let loaded;
      try {
        loaded = await load();
      } catch {
        return { ok: false, error: "storage_failed" };
      }
      // 更新版本的插件写的配方：看不懂，也不覆盖。
      if (loaded.status === "unsupported") return { ok: false, error: "unsupported_version" };
      const result = change(loaded.store);
      if (!result.ok) return result;
      if (result.store === loaded.store && loaded.status === "ok") return { ...result, store: undefined };
      try {
        await area.set({ [STORAGE_KEY]: result.store });
      } catch {
        return { ok: false, error: "storage_failed" };
      }
      return { ...result, store: undefined };
    });
    return {
      read: () => queue(async () => {
        try {
          return await load();
        } catch {
          return { status: "failed", store: emptyStore() };
        }
      }),
      save: (host, path, recipe) => mutate(store => upsert(store, host, path, recipe, now())),
      remove: (host, path) => mutate(store => removeRecipe(store, host, path)),
      touch: (host, path) => mutate(store => touchRecipe(store, host, path, now()))
    };
  }

  // 侧栏和诊断只看得到这些：有没有配方、要不要先点按钮、字段数。不含定位信息本身。
  function summary(recipe) {
    if (!recipe) return null;
    return { fields: recipe.fields.length, actions: recipe.actions?.length || 0, sections: recipe.sections?.length || 0 };
  }

  const api = {
    STORAGE_KEY, VERSION, MAX_SITES, MAX_RECIPES_PER_SITE, MAX_RECIPE_BYTES, MAX_TOTAL_BYTES, MAX_FIELDS, MIN_RATIO, MAX_FAILED,
    TOUCH_INTERVAL_MS,
    pageKey, stableToken, scopeKey, fingerprint, actionLocators, buildRecipe, sanitizeRecipe, locateFields, locateActions, toSpecFields,
    saveDecision, readStore, lookup, findRecipe, upsert, removeRecipe, touchRecipe, createStore, summary, encodedBytes, validHost, validPath
  };
  scope.ResumeProPageRecipe = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
