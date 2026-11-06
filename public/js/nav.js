// nav.js — 顶部栏 + 学生 / 商家 / 管理员 切换（三个版本共用）
// 用法：页面放 <header id="topbar"></header>，然后 renderNav("student" | "merchant" | "admin", "副标题")
import { BACKEND, setBackend } from "./api.js";
import { esc } from "./util.js";

const ROLES = [
  { key: "student", label: "学生", href: "/" },
  { key: "merchant", label: "商家", href: "/merchant.html" },
  { key: "admin", label: "管理员", href: "/admin.html" },
];

export function renderNav(role, subtitle = "") {
  const el = document.getElementById("topbar");
  if (!el) return;
  try { localStorage.setItem("fsa_role", role); } catch {}
  el.className = "topbar";
  el.innerHTML =
    '<div class="topbar-row">'
    + '<a href="/" class="brand">🍜 找店助手</a>'
    + (subtitle ? '<span class="sub">' + esc(subtitle) + "</span>" : "")
    + '<nav class="roles" aria-label="切换版本">'
    + ROLES.map((r) => '<a href="' + r.href + '"' + (r.key === role ? ' aria-current="page"' : "") + ">" + r.label + "</a>").join("")
    + "</nav></div>";
  if (BACKEND === "local") {
    const bar = document.createElement("div");
    bar.className = "demo-bar";
    bar.innerHTML = "本地演示模式：数据只保存在这个浏览器里。 <button type=\"button\">切换到云端</button>";
    bar.querySelector("button").addEventListener("click", () => setBackend("cloud"));
    el.after(bar);
  }
}
