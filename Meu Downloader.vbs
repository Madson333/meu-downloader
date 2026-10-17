' Starts Meu Downloader without a console window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
' Compile the TypeScript sources first, so the app always runs the current code.
shell.Run "cmd /c npm run build", 0, True
shell.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """", 0, False
