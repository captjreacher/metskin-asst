param(
  [string]$DbId  = $env:NOTION_DB_ID,
  [string]$Token = $env:NOTION_TOKEN
)

if (-not $DbId -or -not $Token) {
  throw "Set NOTION_DB_ID and NOTION_TOKEN environment variables first."
}

# Title property name. If your title column is not Sample_id, set NOTION_TITLE_PROP env var.
$TitleProp = if ($env:NOTION_TITLE_PROP) { $env:NOTION_TITLE_PROP } else { "Sample_id" }

# Expected properties (names and Notion types)
$Expected = @(
  @{ Name = $TitleProp    ; Type = "title"     }  # page title
  @{ Name = "order_status"; Type = "rich_text" }
  @{ Name = "sent_by"     ; Type = "rich_text" }
  @{ Name = "date_sent"   ; Type = "date"      }  # remove if you do not use it
)

$headers = @{
  "Authorization"  = "Bearer $Token"
  "Notion-Version" = "2022-06-28"
}

try {
  $db = Invoke-RestMethod -Method GET -Uri "https://api.notion.com/v1/databases/$DbId" -Headers $headers
} catch {
  Write-Error "Failed to load database schema from Notion. $($_.Exception.Message)"
  throw
}

# Build map: property name -> type
$actual = @{}
foreach ($p in $db.properties.PSObject.Properties) {
  $actual[$p.Name] = $p.Value.type
}

# Case-insensitive index: lower(name) -> actual name
$actualLower = @{}
foreach ($n in $actual.Keys) { $actualLower[$n.ToLower()] = $n }

$rows = foreach ($e in $Expected) {
  $expName = $e.Name
  $expType = $e.Type

  if ($actual.ContainsKey($expName)) {
    $t = $actual[$expName]
    $status = if ($t -eq $expType) { "OK" } else { "TYPE MISMATCH" }
    [pscustomobject]@{
      Expected     = $expName
      ExpectedType = $expType
      FoundName    = $expName
      FoundType    = $t
      Status       = $status
    }
  }
  elseif ($actualLower.ContainsKey($expName.ToLower())) {
    $realName = $actualLower[$expName.ToLower()]
    $t = $actual[$realName]
    $status = if ($t -eq $expType) { "CASE MISMATCH" } else { "CASE+TYPE MISMATCH" }
    [pscustomobject]@{
      Expected     = $expName
      ExpectedType = $expType
      FoundName    = $realName
      FoundType    = $t
      Status       = $status
    }
  }
  else {
    [pscustomobject]@{
      Expected     = $expName
      ExpectedType = $expType
      FoundName    = "-"
      FoundType    = "-"
      Status       = "MISSING"
    }
  }
}

$rows | Format-Table -AutoSize

# Show unexpected properties present in Notion
$expectedLower = $Expected.Name | ForEach-Object { $_.ToLower() }
$extras = $actual.Keys | Where-Object { $expectedLower -notcontains $_.ToLower() }

if ($extras.Count -gt 0) {
  Write-Host ""
  Write-Host "Extras present in Notion (not expected by the app):"
  foreach ($x in $extras) {
    Write-Host (" - {0} ({1})" -f $x, $actual[$x])
  }
} else {
  Write-Host ""
  Write-Host "No unexpected properties found."
}
