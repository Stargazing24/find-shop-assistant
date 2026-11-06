// config.js — 应用公开配置（仅公开信息，无任何密钥/口令）
// endpoint 和 publishableKey 是 WorkBuddy 云服务的公开配置，用于前端 SDK 直连。
// 口令（商家/管理员）绝不在这里，只在云数据库 app_secrets 表中以哈希存储、由后端函数校验。
window.APP_CONFIG = {
  endpoint: "https://find-shop.app.workbuddy.host",
  publishableKey: "wbpk_IimcohoFnAq3SDB5UC28FT_Av9Jb8ojOaY0ZfS9ZbwzpJYWDBl9zS8q",
  // 固定的找店/识别模型（不写 Auto，记入日志）
  model: "deepseek-v4.1-flash",
  // 每个浏览器会话最多提问次数（仅前端 UX 提示，不能作为安全边界）
  maxQuestionsPerSession: 20,
};
