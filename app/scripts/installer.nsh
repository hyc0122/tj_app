!include "FileFunc.nsh"

; 已部署天将版本与历史 appId 的固定卸载项 UUID。只保留不可逆标识，不写入旧品牌文本。
!define TIANJIANG_CURRENT_COMPAT_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\0c294ca0-afc0-5702-a263-7225ad1877de"
!define TIANJIANG_LEGACY_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\7ffeed0f-376c-573d-89d2-b0ef69e32d8c"

Function GetTianjiangLocationFromUninstallString
  ; 输入 $0 为批准卸载项的 UninstallString；输出 $0 为安全父目录，非法格式返回空。
  StrCpy $R6 "$0"
  StrCpy $0 ""
  StrCmp $R6 "" tianjiang_uninstall_location_done

  ; electron-builder 正常值用引号包围可执行文件，参数只允许已知安装范围标记。
  StrCpy $R7 "$R6" 1
  StrCmp $R7 '"' tianjiang_uninstall_quoted tianjiang_uninstall_unquoted

  tianjiang_uninstall_quoted:
    StrCpy $R6 "$R6" "" 1
    StrCpy $R8 0

  tianjiang_uninstall_quote_loop:
    StrCpy $R7 "$R6" 1 $R8
    StrCmp $R7 "" tianjiang_uninstall_location_done
    StrCmp $R7 '"' tianjiang_uninstall_quote_found
    IntOp $R8 $R8 + 1
    Goto tianjiang_uninstall_quote_loop

  tianjiang_uninstall_quote_found:
    StrCpy $R9 "$R6" "" $R8
    StrCpy $R6 "$R6" $R8
    StrCmp $R9 '"' tianjiang_uninstall_validate
    StrCmp $R9 '" /allusers' tianjiang_uninstall_validate
    StrCmp $R9 '" /currentuser' tianjiang_uninstall_validate
    Goto tianjiang_uninstall_location_done

  tianjiang_uninstall_unquoted:
    ; 兼容旧安装器未加引号的值，但只剥离精确的范围参数，不接受任意命令行。
    StrCpy $R7 "$R6" 10 -10
    StrCmp $R7 " /allusers" tianjiang_uninstall_strip_allusers
    StrCpy $R7 "$R6" 13 -13
    StrCmp $R7 " /currentuser" tianjiang_uninstall_strip_currentuser tianjiang_uninstall_validate

  tianjiang_uninstall_strip_allusers:
    StrCpy $R6 "$R6" -10
    Goto tianjiang_uninstall_validate

  tianjiang_uninstall_strip_currentuser:
    StrCpy $R6 "$R6" -13

  tianjiang_uninstall_validate:
    ; 只接受本机绝对盘符路径和 electron-builder 的卸载文件名形态。
    StrCpy $R7 "$R6" 1 1
    StrCmp $R7 ":" 0 tianjiang_uninstall_location_done
    StrCpy $R7 "$R6" 1 2
    StrCmp $R7 "\" 0 tianjiang_uninstall_location_done
    ${GetFileExt} "$R6" $R7
    StrCmp $R7 "exe" 0 tianjiang_uninstall_location_done
    ${GetFileName} "$R6" $R7
    StrCpy $R8 "$R7" 10
    StrCmp $R8 "Uninstall " 0 tianjiang_uninstall_location_done
    ${GetParent} "$R6" $R7
    StrCmp $R7 "" tianjiang_uninstall_location_done
    StrCpy $0 "$R7"

  tianjiang_uninstall_location_done:
FunctionEnd

Function NormalizeTianjiangInstallLocation
  ; 用码点构造旧目录名，仅用于一次性升级迁移，正式源码不保留可读旧品牌。
  StrCpy $R2 ""
  IntFmt $R1 "%c" 116
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 111
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 111
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 110
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 102
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 108
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 111
  StrCpy $R2 "$R2$R1"
  IntFmt $R1 "%c" 119
  StrCpy $R2 "$R2$R1"

  ${GetFileName} "$0" $R3
  StrCmp $R3 $R2 tianjiang_legacy_tail

  ; 历史错误值若已经重复 tianjiang，只保留一个末级目录。
  StrCmp $R3 "tianjiang" 0 tianjiang_location_normalized
  ${GetParent} "$0" $R4
  ${GetFileName} "$R4" $R5
  StrCmp $R5 "tianjiang" 0 tianjiang_location_normalized
  StrCpy $0 "$R4"
  Goto tianjiang_location_normalized

  tianjiang_legacy_tail:
    ${GetParent} "$0" $R4
    ${GetFileName} "$R4" $R5
    StrCmp $R5 "tianjiang" tianjiang_use_parent
    ; 自定义父目录继续保留，只把旧产品末级目录替换为 tianjiang。
    StrCpy $0 "$R4\tianjiang"
    Goto tianjiang_location_normalized

  tianjiang_use_parent:
    StrCpy $0 "$R4"

  tianjiang_location_normalized:
FunctionEnd

!macro customPageAfterChangeDir
  ; 自有目录页直接采用用户选择值，不执行 electron-builder 的 APP_FILENAME 追加逻辑。
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro preInit
  ; 依次读取 64/32 位、机器/用户注册表，任何既有位置都优先于新默认值。
  SetRegView 64
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" 0 tianjiang_install_location_ready
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" 0 tianjiang_install_location_ready

  SetRegView 32
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" 0 tianjiang_install_location_ready
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" 0 tianjiang_install_location_ready

  ; InstallLocation 缺失时，只从当前批准键的 UninstallString 恢复目录。
  SetRegView 64
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_install_uninstall_hkcu
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_install_uninstall_hkcu tianjiang_install_location_ready
  tianjiang_current_install_uninstall_hkcu:
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_install_uninstall_hklm32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_install_uninstall_hklm32 tianjiang_install_location_ready
  tianjiang_current_install_uninstall_hklm32:

  SetRegView 32
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_install_uninstall_hkcu32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_install_uninstall_hkcu32 tianjiang_install_location_ready
  tianjiang_current_install_uninstall_hkcu32:
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_uninstall_hklm64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_uninstall_hklm64 tianjiang_install_location_ready
  tianjiang_current_uninstall_hklm64:

  SetRegView 64
  ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_uninstall_hkcu64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_uninstall_hkcu64 tianjiang_install_location_ready
  tianjiang_current_uninstall_hkcu64:
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_uninstall_hklm32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_uninstall_hklm32 tianjiang_install_location_ready
  tianjiang_current_uninstall_hklm32:

  SetRegView 32
  ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_uninstall_hkcu32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_uninstall_hkcu32 tianjiang_install_location_ready
  tianjiang_current_uninstall_hkcu32:
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_compat_uninstall_hklm64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_compat_uninstall_hklm64 tianjiang_install_location_ready
  tianjiang_current_compat_uninstall_hklm64:

  ; 兼容本机已部署的天将卸载项 UUID，读取范围仍仅限 UninstallString。
  SetRegView 64
  ReadRegStr $0 HKLM "${TIANJIANG_CURRENT_COMPAT_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_compat_uninstall_hkcu64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_compat_uninstall_hkcu64 tianjiang_install_location_ready
  tianjiang_current_compat_uninstall_hkcu64:
  ReadRegStr $0 HKCU "${TIANJIANG_CURRENT_COMPAT_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_compat_uninstall_hklm32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_compat_uninstall_hklm32 tianjiang_install_location_ready
  tianjiang_current_compat_uninstall_hklm32:

  SetRegView 32
  ReadRegStr $0 HKLM "${TIANJIANG_CURRENT_COMPAT_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_current_compat_uninstall_hkcu32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_current_compat_uninstall_hkcu32 tianjiang_install_location_ready
  tianjiang_current_compat_uninstall_hkcu32:
  ReadRegStr $0 HKCU "${TIANJIANG_CURRENT_COMPAT_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_legacy_uninstall_hklm64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_legacy_uninstall_hklm64 tianjiang_install_location_ready
  tianjiang_legacy_uninstall_hklm64:

  ; 最后兼容历史 appId 的固定卸载项，不枚举注册表，也不读取其他值。
  SetRegView 64
  ReadRegStr $0 HKLM "${TIANJIANG_LEGACY_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_legacy_uninstall_hkcu64
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_legacy_uninstall_hkcu64 tianjiang_install_location_ready
  tianjiang_legacy_uninstall_hkcu64:
  ReadRegStr $0 HKCU "${TIANJIANG_LEGACY_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_legacy_uninstall_hklm32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_legacy_uninstall_hklm32 tianjiang_install_location_ready
  tianjiang_legacy_uninstall_hklm32:

  SetRegView 32
  ReadRegStr $0 HKLM "${TIANJIANG_LEGACY_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_legacy_uninstall_hkcu32
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_legacy_uninstall_hkcu32 tianjiang_install_location_ready
  tianjiang_legacy_uninstall_hkcu32:
  ReadRegStr $0 HKCU "${TIANJIANG_LEGACY_UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" tianjiang_use_default_install_location
  Call GetTianjiangLocationFromUninstallString
  StrCmp $0 "" tianjiang_use_default_install_location tianjiang_install_location_ready

  ; 全新安装默认使用 64 位 Program Files，assisted 安装页仍允许用户修改。
  tianjiang_use_default_install_location:
  StrCpy $0 "$PROGRAMFILES64\tianjiang"

  tianjiang_install_location_ready:
    ; 先迁移旧尾目录或重复末级目录，合法自定义路径保持原值。
    Call NormalizeTianjiangInstallLocation
    ; 将已找到或新默认值镜像到各注册表视图，升级解析始终得到同一路径。
    SetRegView 64
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$0"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$0"
    SetRegView 32
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$0"
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$0"
    SetRegView 64
!macroend

!macro customInstall
  ; 运行库已在构建期验证并嵌入安装包，客户端安装时不访问网络。
  StrCpy $0 "$INSTDIR\resources\prerequisites\vc_redist.x64.exe"
  IfFileExists "$0" runtime_ready runtime_missing

  runtime_ready:
    DetailPrint "正在安装天将漫创所需的 Microsoft VC++ x64 运行库..."
    nsExec::ExecToLog '"$0" /install /quiet /norestart'
    Pop $1
    DetailPrint "Microsoft VC++ 运行库安装返回码：$1"
    ${If} $1 == "3010"
      SetRebootFlag true
    ${ElseIf} $1 == "1638"
      ; 已安装相同或更高版本，继续安装主程序。
    ${ElseIf} $1 != "0"
      MessageBox MB_OK|MB_ICONSTOP "天将漫创运行组件安装失败（代码：$1）。安装已停止，请重新运行官方安装程序。"
      Abort
    ${EndIf}
    Delete "$0"
    Goto runtime_done

  runtime_missing:
    MessageBox MB_OK|MB_ICONSTOP "官方安装包缺少必要运行组件，安装已停止。请重新下载完整安装包。"
    Abort

  runtime_done:
!macroend
