Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Khởi động máy chủ Node.js hoàn toàn ẩn dưới nền (WindowStyle = 0: Không hiện cửa sổ đen)
WshShell.Run "cmd /c cd /d """ & currentDir & """ && runtime\node.exe server.js", 0, False

' 2. Đợi 1 giây để server sẵn sàng rồi tự động mở trình duyệt
WScript.Sleep 1000
WshShell.Run "http://localhost:4000"
