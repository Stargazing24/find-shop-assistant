// shop-editor.js — 商家版共用的编辑组件：菜单照片识别、菜品表格、店铺信息表单
import { esc, WEEKDAY_CN, AREAS, newId } from "./util.js";
import { extractMenu } from "./api.js";

// ---------------- 图片压缩（长边 ≤1600 的 JPEG dataURL） ----------------
async function compressImage(file, maxDim = 1600, quality = 0.85) {
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const el = new Image(); el.onload = () => res(el); el.onerror = rej; el.src = dataUrl; });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) { const k = maxDim / Math.max(width, height); width = Math.round(width * k); height = Math.round(height * k); }
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  c.getContext("2d").drawImage(img, 0, 0, width, height);
  return c.toDataURL("image/jpeg", quality);
}

// ---------------- 菜单照片识别 ----------------
// onResult(dishes, log)：识别成功时回调；dishes 已带 id、confidence、source="menu_photo"
export function createPhotoRecognizer(container, onResult) {
  container.innerHTML =
    '<input type="file" accept="image/*" multiple class="pr-files" style="margin-top:4px">'
    + '<div class="hint">可上传 1–3 张菜单照片，AI 识别菜品和价格，识别后请逐行核对。</div>'
    + '<div class="pr-preview"></div>'
    + '<button class="btn secondary pr-go" style="margin-top:10px" disabled>识别菜单</button>'
    + '<div class="hint pr-status"></div>';
  const q = (s) => container.querySelector(s);
  let images = [];
  q(".pr-files").addEventListener("change", async (e) => {
    images = [];
    q(".pr-preview").innerHTML = "";
    const files = [...(e.target.files || [])].slice(0, 3);
    q(".pr-go").disabled = !files.length;
    for (const f of files) {
      const u = await compressImage(f);
      images.push(u);
      q(".pr-preview").insertAdjacentHTML("beforeend", '<img class="img-preview" src="' + u + '">');
    }
    q(".pr-status").textContent = files.length ? "已选择 " + files.length + " 张" : "";
  });
  q(".pr-go").addEventListener("click", async () => {
    if (!images.length) return;
    q(".pr-go").disabled = true;
    q(".pr-status").textContent = "识别中，请稍候…";
    const t0 = Date.now();
    try {
      const ex = await extractMenu(images);
      const sec = (Date.now() - t0) / 1000;
      if (!ex.ok || !ex.dishes.length) {
        q(".pr-status").textContent = "识别失败（" + ((ex.errors || []).join("、") || "未识别到菜品") + "），可以手动添加菜品。";
        return;
      }
      const dishes = ex.dishes.map((d) => ({
        id: newId("dish"), name: d.name, price: d.price ?? null, category: d.category ?? null,
        spicy_level: d.spicy_level ?? null, is_vegetarian: d.is_vegetarian ?? null, is_signature: d.is_signature === true,
        confidence: d.confidence ?? 0.5, source: "menu_photo", vendor_confirmed: false,
      }));
      q(".pr-status").textContent = "识别到 " + dishes.length + " 道菜（" + sec.toFixed(1) + " 秒），已加入下方表格，请核对。";
      onResult(dishes, { raw: ex.raw, timings: ex.timings, attempts: ex.attempts, firstTryOk: ex.firstTryOk, promptVersion: ex.promptVersion });
    } catch (e) {
      console.error(e);
      q(".pr-status").textContent = "识别失败：" + (e.message || String(e)) + "。可以手动添加菜品。";
    } finally {
      q(".pr-go").disabled = false;
    }
  });
}

// ---------------- 菜品表格 ----------------
export function createDishEditor(container) {
  let dishes = [];
  let edited = 0;
  const SP = ["未提供", "不辣", "微辣", "中辣", "特辣"];

  function render() {
    let html = "";
    if (!dishes.length) html += '<div class="empty">暂无菜品，可以拍照识别或手动添加。</div>';
    else {
      html += '<div style="overflow-x:auto"><table><tr><th>菜品名</th><th>价格</th><th>辣度</th><th>素食</th><th>招牌</th><th></th></tr>';
      dishes.forEach((d, i) => {
        const flag = d.confidence != null && d.confidence < 0.8 && !d.vendor_confirmed ? ' <span class="confirm-flag">请确认</span>' : "";
        html += '<tr data-i="' + i + '">'
          + '<td><input type="text" data-f="name" value="' + esc(d.name) + '" style="min-width:110px">' + flag + "</td>"
          + '<td><input type="number" data-f="price" value="' + (d.price ?? "") + '" style="width:72px" min="0" step="0.5"></td>'
          + '<td><select data-f="spicy_level">' + SP.map((s, k) => '<option value="' + (k - 1) + '"' + ((d.spicy_level ?? -1) === k - 1 ? " selected" : "") + ">" + s + "</option>").join("") + "</select></td>"
          + '<td><select data-f="is_vegetarian"><option value="">未提供</option><option value="true"' + (d.is_vegetarian === true ? " selected" : "") + '>是</option><option value="false"' + (d.is_vegetarian === false ? " selected" : "") + ">否</option></select></td>"
          + '<td><input type="checkbox" data-f="is_signature"' + (d.is_signature ? " checked" : "") + "></td>"
          + '<td><button type="button" class="btn-sm danger" data-del="' + i + '">删除</button></td></tr>';
      });
      html += "</table></div>";
    }
    html += '<button type="button" class="btn secondary de-add" style="margin-top:10px">+ 手动添加一道菜</button>';
    container.innerHTML = html;

    container.querySelectorAll("tr[data-i] input, tr[data-i] select").forEach((el) =>
      el.addEventListener("change", () => {
        const d = dishes[Number(el.closest("tr").dataset.i)];
        const f = el.dataset.f;
        if (f === "name") d.name = el.value.trim();
        else if (f === "price") d.price = el.value === "" ? null : Number(el.value);
        else if (f === "spicy_level") d.spicy_level = el.value === "-1" ? null : Number(el.value);
        else if (f === "is_vegetarian") d.is_vegetarian = el.value === "" ? null : el.value === "true";
        else if (f === "is_signature") d.is_signature = el.checked;
        if (!d.vendor_confirmed || d.confidence !== 1) edited++;
        d.vendor_confirmed = true; d.confidence = 1;
        const flag = el.closest("tr").querySelector(".confirm-flag");
        if (flag) flag.remove();
      }));
    container.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => { dishes.splice(Number(b.dataset.del), 1); render(); }));
    container.querySelector(".de-add").addEventListener("click", () => {
      dishes.push({ id: newId("dish"), name: "", price: null, category: null, spicy_level: null, is_vegetarian: null, is_signature: false, confidence: 1, source: "vendor_input", vendor_confirmed: true });
      render();
    });
  }

  render();
  return {
    set(list) { dishes = (list || []).map((d) => ({ ...d })); edited = 0; render(); },
    append(list) { dishes = dishes.concat(list); render(); },
    get() { return dishes.filter((d) => d.name && d.name.trim()); },
    unconfirmed() { return dishes.filter((d) => d.confidence != null && d.confidence < 0.8 && !d.vendor_confirmed).length; },
    editedCount() { return edited; },
  };
}

// ---------------- 店铺信息表单 ----------------
export function createInfoForm(container) {
  container.innerHTML = `
    <label>店名 <span style="color:var(--red)">*</span></label><input type="text" data-k="name" placeholder="必填">
    <label>菜系（用顿号分隔，如：粤菜、面食）</label><input type="text" data-k="cuisine" placeholder="选填">
    <div class="inline-fields">
      <div><label>区域</label><select data-k="area"><option value="">未提供</option>${AREAS.map((a) => `<option>${a}</option>`).join("")}</select></div>
      <div><label>人均（元）</label><input type="number" data-k="avg_price" min="0" step="1" placeholder="选填"></div>
    </div>
    <label>地址</label><input type="text" data-k="address" placeholder="选填">
    <label>营业时间</label>
    <label class="chk" style="margin-top:0"><input type="checkbox" class="same"> 每天相同</label>
    <div class="hours"></div>
    <div class="hint">某天不营业就留空；跨夜营业（如 18:00–02:00）直接填写即可。</div>
    <label>服务方式（用顿号分隔，如：堂食、自取、外卖）</label><input type="text" data-k="services" placeholder="选填">
    <label>简介</label><textarea data-k="description" placeholder="选填，一句话介绍你的店"></textarea>
    <label>联系方式</label><input type="text" data-k="contact" placeholder="选填，如电话或微信号">
    <label>店铺公告</label><textarea data-k="notice" placeholder="选填，如：本周日停业一天；新品上市"></textarea>`;
  const q = (s) => container.querySelector(s);
  const field = (k) => container.querySelector(`[data-k="${k}"]`);
  let hours = [];

  function renderHours() {
    const same = q(".same").checked;
    const days = same ? [0] : [0, 1, 2, 3, 4, 5, 6];
    q(".hours").innerHTML = days.map((wd) => {
      const r = hours.find((h) => h.weekday === wd) || {};
      return `<div class="hours-row"><label>${same ? "每天" : WEEKDAY_CN[wd]}</label>
        <input type="time" data-wd="${wd}" data-x="open" value="${esc(r.open || "")}"><span>–</span>
        <input type="time" data-wd="${wd}" data-x="close" value="${esc(r.close || "")}"></div>`;
    }).join("");
  }
  function readHours(same = q(".same").checked) {
    const out = [];
    for (const row of q(".hours").querySelectorAll(".hours-row")) {
      const o = row.querySelector('[data-x="open"]').value, c = row.querySelector('[data-x="close"]').value;
      if (!o || !c) continue;
      const wd = Number(row.querySelector('[data-x="open"]').dataset.wd);
      if (same) { for (let d = 0; d < 7; d++) out.push({ weekday: d, open: o, close: c }); }
      else out.push({ weekday: wd, open: o, close: c });
    }
    return out;
  }
  // 切换"每天相同"时，按切换前的模式读出已填的时间再重画
  q(".same").addEventListener("change", () => { hours = readHours(!q(".same").checked); renderHours(); });

  const split = (v) => String(v || "").split(/[、,，\s]+/).filter(Boolean);
  return {
    set(shop) {
      const s = shop || {};
      field("name").value = s.name || "";
      field("cuisine").value = (s.cuisine || []).join("、");
      field("area").value = s.area || "";
      field("avg_price").value = s.avg_price ?? "";
      field("address").value = s.address || "";
      field("services").value = (s.services || []).join("、");
      field("description").value = s.description || "";
      field("contact").value = s.contact || "";
      field("notice").value = s.notice || "";
      hours = (s.opening_hours || []).slice();
      // 7 天各一段且完全相同 → 勾选"每天相同"
      const same = hours.length === 7 && new Set(hours.map((h) => h.open + "-" + h.close)).size === 1 && new Set(hours.map((h) => h.weekday)).size === 7;
      q(".same").checked = same || hours.length === 0;
      renderHours();
    },
    get() {
      const t = (k) => field(k).value.trim() || null;
      return {
        name: field("name").value.trim(),
        cuisine: split(field("cuisine").value),
        area: field("area").value || null,
        avg_price: field("avg_price").value === "" ? null : Number(field("avg_price").value),
        address: t("address"),
        opening_hours: readHours(),
        services: split(field("services").value),
        description: t("description"),
        contact: t("contact"),
        notice: t("notice"),
      };
    },
  };
}
