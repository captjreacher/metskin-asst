# print-tree.ps1
# Prints the folder structure of the metsksin-asst repo
# Usage: Run in PowerShell: .\print-tree.ps1

$root = "C:\dev_local\maximisedai\metskin-asst"

function Print-Tree($path, $indent = "") {
    Write-Output "$indent$(Split-Path $path -Leaf)"

    $items = Get-ChildItem -LiteralPath $path | Sort-Object -Property PSIsContainer, Name
    foreach ($item in $items) {
        if ($item.PSIsContainer) {
            Print-Tree $item.FullName ($indent + "│   ")
        } else {
            Write-Output "$indent│   $($item.Name)"
        }
    }
}

Print-Tree $root
