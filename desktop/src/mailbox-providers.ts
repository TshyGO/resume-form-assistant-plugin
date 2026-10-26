export interface MailEndpoint { host: string; port: number; encryption: "tls" | "starttls"; username: string; sendId: boolean }
export interface MailEndpointConfirmation extends MailEndpoint { email: string }
export interface MailConnection extends MailEndpoint { endpointConfirmation?: MailEndpointConfirmation }
const TRUSTED_MAIL_HOSTS = new Set(["imap.qq.com", "imap.163.com", "imap.126.com", "imap.gmail.com", "imap.mail.me.com", "imap.sina.com", "imap.sina.cn", "imap.vip.sina.com", "imap.vip.sina.cn", "imap.sohu.com", "imap.aliyun.com", "imap.139.com", "imap.exmail.qq.com", "imap.qiye.163.com"]);
export function requiresEndpointConfirmation(email: string, config: MailEndpoint): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const host = config.host.trim().toLowerCase();
  if (!host || !domain) return false;
  const inDomain = host === domain || host.endsWith(`.${domain}`);
  return !inDomain && !(config.port === 993 && config.encryption === "tls" && TRUSTED_MAIL_HOSTS.has(host));
}
export function endpointConfirmation(email: string, config: MailEndpoint): MailEndpointConfirmation {
  return { email: email.trim().toLowerCase(), host: config.host.trim().toLowerCase(), port: config.port,
    encryption: config.encryption, username: config.username.trim(), sendId: config.sendId };
}
export function matchesEndpointConfirmation(email: string, config: MailEndpoint, confirmation: MailEndpointConfirmation | null | undefined): boolean {
  const expected = endpointConfirmation(email, config);
  return !!confirmation && (Object.keys(expected) as Array<keyof MailEndpointConfirmation>).every((key) => expected[key] === confirmation[key]);
}
export type MailProvider = "qq" | "163" | "126" | "gmail" | "icloud" | "sina" | "sohu" | "aliyun" | "139" | "school";
export interface MailGuide { label: string; secret: string; hint: string; url: string | null; steps: string[] }
export const MAIL_GUIDES: Record<MailProvider, MailGuide> = {
  qq: { label: "QQ 邮箱", secret: "邮箱授权码", hint: "开启 IMAP 后生成授权码，不是 QQ 登录密码。", url: "https://service.mail.qq.com/", steps: ["登录 QQ 邮箱网页版，进入设置 → 账号与安全；旧版位于账号页。", "开启 IMAP/SMTP 服务，按页面要求完成安全验证。", "生成并复制授权码，回到这里测试连接并保存。"] },
  "163": { label: "163 邮箱", secret: "邮箱授权码", hint: "开启 IMAP 后生成客户端授权码，不是登录密码。", url: "https://help.mail.163.com/", steps: ["登录 163 邮箱网页版，打开设置 → POP3/SMTP/IMAP。", "开启 IMAP/SMTP 服务，按要求完成手机验证。", "生成客户端授权码，回到这里测试连接并保存。"] },
  "126": { label: "126 邮箱", secret: "邮箱授权码", hint: "开启 IMAP 后生成客户端授权码，不是登录密码。", url: "https://help.mail.126.com/", steps: ["登录 126 邮箱网页版，打开设置 → POP3/SMTP/IMAP。", "开启 IMAP/SMTP 服务，按要求完成手机验证。", "生成客户端授权码，回到这里测试连接并保存。"] },
  gmail: { label: "Gmail", secret: "应用专用密码", hint: "先开启 Google 两步验证，再生成应用专用密码；部分账号受组织或安全策略限制。", url: "https://support.google.com/mail/answer/185833?hl=zh-Hans", steps: ["进入 Google 账号 → 安全性，开启两步验证。", "打开应用专用密码，创建供网申快填使用的密码；若没有此入口，请查看官方帮助或联系管理员。", "复制生成的应用专用密码，回到这里测试连接。不要填写 Google 登录密码。"] },
  icloud: { label: "iCloud", secret: "App 专用密码", hint: "在 Apple 账户开启双重认证后生成 App 专用密码。登录账号可按 Apple 教程改为邮箱 @ 前的名称。", url: "https://support.apple.com/zh-cn/102654", steps: ["登录 Apple 账户网站，确认已开启双重认证。", "进入登录和安全 → App 专用密码，生成供网申快填使用的密码。", "回到这里粘贴并测试连接；若认证失败，按 Apple 教程核对登录账号。"] },
  sina: { label: "新浪邮箱", secret: "邮箱授权码", hint: "开启客户端授权码与 IMAP 服务，使用生成的 16 位授权码。", url: "https://help.sina.com.cn/comquestiondetail/view/1566/", steps: ["登录新浪邮箱网页版，进入设置 → 客户端 pop/imap/smtp。", "开启授权码状态，完成手机验证，同时开启 IMAP 服务。", "复制只展示一次的 16 位授权码，回到这里测试连接并保存。"] },
  sohu: { label: "搜狐邮箱", secret: "客户端独立密码", hint: "在邮箱网页端开启 IMAP，使用客户端独立密码；以账号当前设置为准。", url: "https://mail.sohu.com/", steps: ["登录搜狐邮箱网页版，进入选项 / 设置 → POP3/SMTP/IMAP。", "开启 IMAP/SMTP 服务，按当前界面要求设置或获取客户端独立密码。", "核对网页端提供的服务器信息，回到这里测试连接并保存。"] },
  aliyun: { label: "阿里邮箱", secret: "客户端专用密码 / 授权码", hint: "请以阿里邮箱账号的安全设置为准；企业邮箱与个人邮箱服务器不同。", url: "https://mailhelp.aliyun.com/", steps: ["登录阿里邮箱网页版，进入设置中的账号安全 / 客户端设置。", "确认 IMAP 已开放，按账号安全策略生成客户端专用密码；没有入口时查看官方帮助或询问管理员。", "个人 aliyun.com 邮箱使用预设；企业邮箱按管理员教程修改服务器，再测试连接。"] },
  "139": { label: "139 邮箱", secret: "邮箱授权码", hint: "在邮箱协议设置中开启 IMAP，并生成授权码。", url: "https://help.mail.10086.cn/statichtml/1/Content/3837.html", steps: ["登录 139 邮箱网页版，进入设置 → 常规设置 → 帐户与安全 → 邮箱协议设置。", "开启 IMAP/SMTP 服务并保存，按页面要求完成验证、获取授权码。", "复制授权码，回到这里测试连接并保存；授权码过期后需重新生成。"] },
  school: { label: "学校 / 其他邮箱", secret: "密码 / 客户端专用密码", hint: "按学校或邮箱官方教程填写登录密码或客户端专用密码，不确定时请先核对。", url: null, steps: ["在学校信息中心查找“邮箱客户端设置 / IMAP”官方教程。", "填写教程提供的 IMAP 域名、端口和加密方式；网页登录地址不能直接作为 IMAP 地址。", "按教程填写登录账号、登录密码或客户端专用密码；无法连接时，可下载 .eml 手动导入。"] },
};
export function mailboxProvider(email: string): MailProvider | null {
  const value = email.trim().toLowerCase();
  if (!/^[a-z0-9._+\-]+@[a-z0-9.-]+$/.test(value)) return null;
  const domain = value.split("@")[1];
  const providers: Record<string, MailProvider> = { "qq.com": "qq", "foxmail.com": "qq", "163.com": "163", "126.com": "126", "gmail.com": "gmail", "googlemail.com": "gmail", "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud", "sina.com": "sina", "sina.cn": "sina", "vip.sina.com": "sina", "vip.sina.cn": "sina", "sohu.com": "sohu", "aliyun.com": "aliyun", "139.com": "139", "mails.tsinghua.edu.cn": "school", "mail.tsinghua.edu.cn": "school" };
  return providers[domain] ?? null;
}
export function localMailConnection(email: string): MailConnection | null {
  const username = email.trim().toLowerCase(), provider = mailboxProvider(email);
  if (!provider) return null;
  const domain = username.split("@")[1];
  const hosts: Record<string, string> = { qq: "imap.qq.com", "163": "imap.163.com", "126": "imap.126.com", gmail: "imap.gmail.com", icloud: "imap.mail.me.com", sina: `imap.${domain}`, sohu: "imap.sohu.com", aliyun: "imap.aliyun.com", "139": "imap.139.com", school: domain };
  return { host: hosts[provider], port: 993, encryption: "tls", username, sendId: provider === "163" || provider === "126" };
}
