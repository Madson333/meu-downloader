' Starts Meu Downloader without a console window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
shell.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """", 0, False
