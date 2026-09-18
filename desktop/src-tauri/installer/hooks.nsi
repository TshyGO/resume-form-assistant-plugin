; 卸载时的收尾。两件事：**清掉我们自己写下的东西**，**不碰用户的求职档案**。
;
; 为什么需要这个文件：
;
; - Tauri 自带的卸载器只删安装目录、快捷方式，以及（勾了「删除应用数据」时）
;   `com.resumepro.desktop` 那两个 WebView 目录。它不知道我们往 HKCU 写过
;   Native Messaging 注册，也不知道 `%LOCALAPPDATA%\ResumePro` 是什么。
; - 注册项留着的后果是：程序已经没了，浏览器扩展还在连一个不存在的文件。
; - 档案目录里是所有申请、附件、待办和备份，**删了找不回来**。所以默认一个字节
;   都不动；真要删，得在一个单独的确认框里再说一次「是」。
;
; 升级走的也是卸载器（`$UpdateMode = 1`），而且**两段都要避开它**：那时候删掉
; 注册项，新版本装好、启动、重新写清单之前，浏览器就连不上；升级要是中断在
; 中间，用户会停在一个「装着旧版但连不上」的状态里。
;
; 这个文件由 `tauri.conf.json` 的 `bundle.windows.nsis.installerHooks` 引入，
; 内容会被插进 Tauri 生成的 installer.nsi，所以 LogicLib（`${If}`）是现成的。

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DetailPrint "清理 Native Messaging 注册…"

    ; 浏览器靠这两个键找到 host。
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.resumepro.desktop"

    ; 清单和回执是应用写进数据目录的，删掉它们不影响档案本身。
    Delete "$LOCALAPPDATA\ResumePro\nm\chrome-com.resumepro.desktop.json"
    Delete "$LOCALAPPDATA\ResumePro\nm\edge-com.resumepro.desktop.json"
    Delete "$LOCALAPPDATA\ResumePro\nm\receipt.json"
    RMDir "$LOCALAPPDATA\ResumePro\nm"
  ${Else}
    DetailPrint "升级中：保留 Native Messaging 注册，新版本启动时会自己核对。"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 静默卸载（$PassiveMode = 1，含 /S）时没人在屏幕前，不能替他做删数据的决定。
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "还要删掉求职档案吗？$\r$\n$\r$\n$LOCALAPPDATA\ResumePro$\r$\n$\r$\n里面是所有申请、附件、待办和备份。删掉之后找不回来。$\r$\n$\r$\n选「否」就只卸载程序，档案原样留着。" \
      IDYES resumeProDeleteArchive IDNO resumeProKeepArchive
    resumeProDeleteArchive:
      DetailPrint "按用户确认删除求职档案…"
      ClearErrors
      RMDir /r "$LOCALAPPDATA\ResumePro"
      ; 文件被占用（桌面还没退干净、杀毒软件正在扫）时会删一半。说出来，
      ; 别让用户以为已经清干净了——他可能正打算把机器转手。
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION \
          "档案没有完全删掉：$\r$\n$\r$\n$LOCALAPPDATA\ResumePro$\r$\n$\r$\n可能有文件正被占用。关掉桌面程序之后手动删除这个目录。"
      ${EndIf}
      Goto resumeProArchiveDone
    resumeProKeepArchive:
      DetailPrint "保留求职档案：$LOCALAPPDATA\ResumePro"
    resumeProArchiveDone:
  ${EndIf}
!macroend
