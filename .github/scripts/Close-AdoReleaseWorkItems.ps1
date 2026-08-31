<#
.SYNOPSIS
    Closes Azure DevOps work items that are referenced by a GitHub release.

.DESCRIPTION
    Collects work item references (AB#<id>) from the release notes and from the commits
    between the previous release and this one, then transitions every referenced work item
    that currently sits in $FromState to $ToState.

    Work items that cannot be found, live in a different Azure DevOps project or are in any
    other state are skipped - they are reported, but they do not fail the run.
    Only real errors (HTTP failures, revision conflicts, rule violations) fail the run.
#>
[CmdletBinding()]
param(
    # Azure DevOps organization name, e.g. 'TRASERSoftwareGmbH'.
    [Parameter(Mandatory = $true)] [string] $Organization,
    # Azure DevOps project name, e.g. 'TSC - Test'. Work items outside of it are skipped.
    [Parameter(Mandatory = $true)] [string] $Project,
    # Azure DevOps PAT with scope 'Work Items (Read & Write)'.
    [Parameter(Mandatory = $true)] [string] $Pat,
    # GitHub repository as 'owner/repo'.
    [Parameter(Mandatory = $true)] [string] $Repository,
    # Tag of the release to process.
    [Parameter(Mandatory = $true)] [string] $ReleaseTag,
    # File containing the release notes (markdown). Optional.
    [string] $ReleaseBodyFile = '',
    # Link to the release, added to the work item history entry.
    [string] $ReleaseUrl = '',
    # Token used for the GitHub API. Falls back to $env:GITHUB_TOKEN.
    [string] $GitHubToken = '',
    [string] $FromState = 'Release Pending',
    [string] $ToState = 'Closed',
    # Report what would happen without writing to Azure DevOps.
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$adoApiVersion = '7.1'

function Get-MissingInputHint {
    # Names of the configured variables/secrets, so a misnamed variable is obvious from the log.
    $hint = @()
    foreach ($pair in @(@{ Label = 'vars'; Json = $env:VARS_JSON }, @{ Label = 'secrets'; Json = $env:SECRETS_JSON })) {
        if ($pair.Json) {
            try {
                $names = ($pair.Json | ConvertFrom-Json).PSObject.Properties.Name | Sort-Object
                $hint += "Available $($pair.Label): $($names -join ', ')"
            }
            catch {
                # Diagnostics only - never let this break the actual error message.
            }
        }
    }
    return $hint -join "`n"
}

foreach ($required in @(
        @{ Name = 'Organization'; Value = $Organization },
        @{ Name = 'Project'; Value = $Project },
        @{ Name = 'Pat'; Value = $Pat })) {
    if ([string]::IsNullOrWhiteSpace($required.Value)) {
        throw "Parameter '$($required.Name)' is empty. Check the variables/secrets in the GitHub environment.`n$(Get-MissingInputHint)"
    }
}

if (-not $GitHubToken) { $GitHubToken = $env:GITHUB_TOKEN }

$githubHeaders = @{
    'Accept'               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'Close-AdoReleaseWorkItems'
}
if ($GitHubToken) { $githubHeaders['Authorization'] = "Bearer $GitHubToken" }

$adoHeaders = @{
    'Authorization' = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$Pat"))
    'Accept'        = 'application/json'
}

function Invoke-GitHubApi {
    param([string] $Path)
    return Invoke-RestMethod -Method Get -Uri "https://api.github.com/$Path" -Headers $githubHeaders
}

function Get-PreviousReleaseTag {
    # The release we just created is the newest one, so the previous published release is the
    # start of the commit range. Drafts are ignored, they never contain shipped work.
    try {
        $releases = Invoke-GitHubApi -Path "repos/$Repository/releases?per_page=100"
    }
    catch {
        Write-Host "::warning::Could not list releases: $($_.Exception.Message)"
        return ''
    }
    $current = $releases | Where-Object { $_.tag_name -eq $ReleaseTag } | Select-Object -First 1
    $candidates = $releases | Where-Object { -not $_.draft -and $_.tag_name -ne $ReleaseTag }
    if ($current) {
        $candidates = $candidates | Where-Object { [datetime]$_.created_at -lt [datetime]$current.created_at }
    }
    $previous = $candidates | Sort-Object { [datetime]$_.created_at } -Descending | Select-Object -First 1
    if ($previous) { return $previous.tag_name }
    return ''
}

function Get-ReferenceText {
    $texts = @()

    if ($ReleaseBodyFile -and (Test-Path -LiteralPath $ReleaseBodyFile)) {
        $body = Get-Content -LiteralPath $ReleaseBodyFile -Raw -Encoding UTF8
        if ($body) {
            Write-Host "Scanning release notes ($($body.Length) characters)"
            $texts += $body
        }
    }

    # The release notes only carry PR titles, so also walk the commits of the range - an AB#
    # reference that only exists in a commit message would otherwise be missed.
    $previousTag = Get-PreviousReleaseTag
    if ($previousTag) {
        Write-Host "Comparing $previousTag...$ReleaseTag"
        try {
            $compare = Invoke-GitHubApi -Path "repos/$Repository/compare/$previousTag...$ReleaseTag`?per_page=250"
            Write-Host "Scanning $($compare.commits.Count) commit message(s)"
            $texts += @($compare.commits | ForEach-Object { $_.commit.message })
        }
        catch {
            Write-Host "::warning::Could not compare $previousTag...$ReleaseTag : $($_.Exception.Message)"
        }
    }
    else {
        # First release of the repository: every commit reachable from the tag belongs to it.
        Write-Host "No previous release found - scanning the history of $ReleaseTag"
        try {
            $commits = Invoke-GitHubApi -Path "repos/$Repository/commits?sha=$ReleaseTag&per_page=100"
            Write-Host "Scanning $($commits.Count) commit message(s)"
            $texts += @($commits | ForEach-Object { $_.commit.message })
        }
        catch {
            Write-Host "::warning::Could not read the history of $ReleaseTag : $($_.Exception.Message)"
        }
    }

    return ($texts -join "`n")
}

function Get-WorkItem {
    param([int] $Id)
    # Organization scoped, so an id from another project resolves instead of returning 404.
    $uri = "https://dev.azure.com/$Organization/_apis/wit/workitems/$Id" +
    "?fields=System.Id,System.TeamProject,System.WorkItemType,System.State,System.Title" +
    "&api-version=$adoApiVersion"
    return Invoke-RestMethod -Method Get -Uri $uri -Headers $adoHeaders
}

function Set-WorkItemState {
    param([int] $Id, [int] $Rev)
    $patch = @(
        # Guard against a concurrent change: if somebody touched the work item after we read it,
        # the patch fails instead of overwriting their state change.
        @{ op = 'test'; path = '/rev'; value = $Rev }
        @{ op = 'replace'; path = '/fields/System.State'; value = $ToState }
    )
    if ($ReleaseUrl) {
        $patch += @{
            op    = 'add'
            path  = '/fields/System.History'
            value = "Closed automatically by release <a href=""$ReleaseUrl"">$ReleaseTag</a>."
        }
    }
    $uri = "https://dev.azure.com/$Organization/_apis/wit/workitems/$Id`?api-version=$adoApiVersion"
    $body = ConvertTo-Json -InputObject $patch -Depth 5
    Invoke-RestMethod -Method Patch -Uri $uri -Headers $adoHeaders -ContentType 'application/json-patch+json' -Body $body | Out-Null
}

function Get-ErrorMessage {
    param($ErrorRecord)
    # Azure DevOps returns the useful part in the response body, not in the exception message.
    try {
        $response = $ErrorRecord.Exception.Response
        if ($response) {
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            $raw = $reader.ReadToEnd()
            $reader.Dispose()
            if ($raw) {
                try { return (($raw | ConvertFrom-Json).message) } catch { return $raw }
            }
        }
    }
    catch {
        # Fall through to the plain exception message.
    }
    return $ErrorRecord.Exception.Message
}

function Get-HttpStatusCode {
    param($ErrorRecord)
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
}

# --- collect work item ids ------------------------------------------------------------------

$text = Get-ReferenceText
$ids = @([regex]::Matches($text, 'AB#(\d+)', 'IgnoreCase') |
    ForEach-Object { [int]$_.Groups[1].Value } |
    Sort-Object -Unique)

Write-Host "Found $($ids.Count) referenced work item(s): $($ids -join ', ')"

# --- process -------------------------------------------------------------------------------

$results = New-Object Collections.ArrayList

foreach ($id in $ids) {
    $entry = [ordered]@{ Id = $id; Type = ''; Title = ''; State = ''; Result = ''; Detail = '' }

    try {
        $workItem = Get-WorkItem -Id $id
    }
    catch {
        $status = Get-HttpStatusCode -ErrorRecord $_
        if ($status -eq 404) {
            $entry.Result = 'skipped'
            $entry.Detail = 'work item does not exist'
        }
        else {
            $entry.Result = 'failed'
            $entry.Detail = "read failed (HTTP $status): $(Get-ErrorMessage -ErrorRecord $_)"
        }
        [void]$results.Add([PSCustomObject]$entry)
        Write-Host "$id -> $($entry.Result): $($entry.Detail)"
        continue
    }

    $entry.Type = $workItem.fields.'System.WorkItemType'
    $entry.Title = $workItem.fields.'System.Title'
    $entry.State = $workItem.fields.'System.State'
    $teamProject = $workItem.fields.'System.TeamProject'

    if ($teamProject -ne $Project) {
        $entry.Result = 'skipped'
        $entry.Detail = "belongs to project '$teamProject'"
    }
    elseif ($entry.State -ne $FromState) {
        $entry.Result = 'skipped'
        $entry.Detail = "not in state '$FromState'"
    }
    elseif ($DryRun) {
        $entry.Result = 'would close'
        $entry.Detail = 'dry run'
    }
    else {
        try {
            Set-WorkItemState -Id $id -Rev $workItem.rev
            $entry.Result = 'closed'
        }
        catch {
            $status = Get-HttpStatusCode -ErrorRecord $_
            $entry.Result = 'failed'
            $entry.Detail = "update failed (HTTP $status): $(Get-ErrorMessage -ErrorRecord $_)"
        }
    }

    [void]$results.Add([PSCustomObject]$entry)
    Write-Host "$id [$($entry.Type)] '$($entry.State)' -> $($entry.Result) $($entry.Detail)"
}

# --- report --------------------------------------------------------------------------------

$closed = @($results | Where-Object { $_.Result -eq 'closed' -or $_.Result -eq 'would close' })
$skipped = @($results | Where-Object { $_.Result -eq 'skipped' })
$failed = @($results | Where-Object { $_.Result -eq 'failed' })

$summary = New-Object Collections.ArrayList
[void]$summary.Add("## Azure DevOps work items - release $ReleaseTag")
[void]$summary.Add('')
if ($DryRun) {
    [void]$summary.Add('> **Dry run** - nothing was written to Azure DevOps.')
    [void]$summary.Add('')
}
[void]$summary.Add("Organization ``$Organization`` &nbsp;&bull;&nbsp; project ``$Project`` &nbsp;&bull;&nbsp; transition ``$FromState`` -> ``$ToState``")
[void]$summary.Add('')
[void]$summary.Add("**$($closed.Count) closed &nbsp;&bull;&nbsp; $($skipped.Count) skipped &nbsp;&bull;&nbsp; $($failed.Count) failed**")
[void]$summary.Add('')

if ($results.Count -eq 0) {
    [void]$summary.Add('No `AB#<id>` references found in this release.')
}
else {
    [void]$summary.Add('| Work item | Type | Title | State before | Result | Detail |')
    [void]$summary.Add('| --- | --- | --- | --- | --- | --- |')
    foreach ($entry in $results) {
        $link = "[AB#$($entry.Id)](https://dev.azure.com/$Organization/_workitems/edit/$($entry.Id))"
        $title = ($entry.Title -replace '\|', '\|')
        if ($title.Length -gt 80) { $title = $title.Substring(0, 77) + '...' }
        [void]$summary.Add("| $link | $($entry.Type) | $title | $($entry.State) | $($entry.Result) | $($entry.Detail) |")
    }
}

$summaryText = $summary -join "`n"
Write-Host $summaryText
if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summaryText -Encoding UTF8
}

if ($failed.Count -gt 0) {
    throw "$($failed.Count) work item(s) could not be updated. See the job summary for details."
}
