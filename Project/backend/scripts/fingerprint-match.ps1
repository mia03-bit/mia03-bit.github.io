# Extracts ANSI 378 FMD templates from DigitalPersona WebSDK Raw samples and
# compares those templates with the locally installed HID FingerJet runtime.
# JSON is exchanged over stdin/stdout; raw fingerprint images remain in memory.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$fingerJetPath = 'C:\Windows\System32\dpfj.dll'
$maximumEncodedSampleBytes = 1024 * 1024
$maximumRawImageBytes = 8 * 1024 * 1024
$maximumFmdBytes = 64 * 1024
$maximumDissimilarity = [int64]2147483647
$ansiFmdFormat = [int]0x001B0001

function Get-JsonProperty {
  param([Parameter(Mandatory = $true)]$Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
  if ($null -eq $property) { return $null }
  return $property.Value
}

function ConvertFrom-Base64Url {
  [OutputType([byte[]])]
  param([Parameter(Mandatory = $true)][string]$Value)
  $encoded = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($encoded) -or $encoded -notmatch '^[A-Za-z0-9_-]+={0,2}$') {
    throw 'Fingerprint sample is not valid base64url data.'
  }
  $encoded = $encoded.TrimEnd('=').Replace('-', '+').Replace('_', '/')
  switch ($encoded.Length % 4) {
    0 { }
    2 { $encoded += '==' }
    3 { $encoded += '=' }
    default { throw 'Fingerprint sample has invalid base64url padding.' }
  }
  try { [byte[]]$bytes = [Convert]::FromBase64String($encoded) }
  catch { throw 'Fingerprint sample is not valid base64url data.' }
  if ($bytes.Length -eq 0 -or $bytes.Length -gt $maximumEncodedSampleBytes) {
    throw 'Fingerprint sample size is outside the supported range.'
  }
  return ,$bytes
}

function ConvertTo-Base64Url {
  param([Parameter(Mandatory = $true)][byte[]]$Value)
  return [Convert]::ToBase64String($Value).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertBytesFromJson {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $offset = 0
  while ($offset -lt $Bytes.Length -and $Bytes[$offset] -in @(9, 10, 13, 32)) { $offset++ }
  if ($offset -ge $Bytes.Length -or [char]$Bytes[$offset] -notin @('{', '[', '"')) { return $null }
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    return ConvertFrom-Json -InputObject ($utf8.GetString($Bytes)) -ErrorAction Stop
  } catch { return $null }
}

function Test-AnsiFmd {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  # ANSI 378 revisions encode the record length differently. FingerJet is the
  # producer and final parser, so validate the invariant format identifier and
  # bounded buffer here instead of imposing one revision's length layout.
  return $Bytes.Length -ge 24 -and $Bytes.Length -le $maximumFmdBytes -and
    $Bytes[0] -eq 0x46 -and $Bytes[1] -eq 0x4D -and $Bytes[2] -eq 0x52 -and $Bytes[3] -eq 0
}

function Get-RawImageDescriptor {
  param([Parameter(Mandatory = $true)]$Object)
  $format = Get-JsonProperty -Object $Object -Name 'Format'
  $dataValue = Get-JsonProperty -Object $Object -Name 'Data'
  if ($null -eq $format -or $dataValue -isnot [string]) { return $null }

  $width = [int](Get-JsonProperty -Object $format -Name 'iWidth')
  $height = [int](Get-JsonProperty -Object $format -Name 'iHeight')
  $xDpi = [int](Get-JsonProperty -Object $format -Name 'iXdpi')
  $yDpi = [int](Get-JsonProperty -Object $format -Name 'iYdpi')
  $bitsPerPixelValue = Get-JsonProperty -Object $format -Name 'uBPP'
  $bitsPerPixel = if ($null -eq $bitsPerPixelValue) { 8 } else { [int]$bitsPerPixelValue }
  $paddingValue = Get-JsonProperty -Object $format -Name 'uPadding'
  $reportedPadding = if ($null -eq $paddingValue) { 0 } else { [int]$paddingValue }
  $compressionValue = Get-JsonProperty -Object $Object -Name 'Compression'
  $compression = if ($null -eq $compressionValue) { 0 } else { [int]$compressionValue }

  if ($width -lt 64 -or $width -gt 2000 -or $height -lt 64 -or $height -gt 2000) {
    throw 'The HID reader returned invalid fingerprint image dimensions.'
  }
  if ($xDpi -lt 250 -or $xDpi -gt 1200 -or $yDpi -ne $xDpi) {
    throw 'The HID reader returned an unsupported fingerprint resolution.'
  }
  if ($bitsPerPixel -ne 8 -or $compression -ne 0) {
    throw 'The HID reader must provide an uncompressed 8-bit raw fingerprint image.'
  }

  [byte[]]$image = ConvertFrom-Base64Url -Value $dataValue
  $expectedLength = $width * $height
  if ($image.Length -gt $maximumRawImageBytes -or $image.Length -lt $expectedLength) {
    throw 'The HID reader returned an incomplete raw fingerprint image.'
  }
  if ($image.Length -ne $expectedLength) {
    $stride = 0
    $pixelOffset = 0
    $bottomUp = $false

    # Some ADC/reader combinations wrap the pixels in an 8-bit BMP. Respect
    # the BMP's declared pixel offset and row alignment when that signature is
    # present, but do not trust dimensions that disagree with the HID metadata.
    if ($image.Length -ge 54 -and $image[0] -eq 0x42 -and $image[1] -eq 0x4D) {
      $bmpOffset = [BitConverter]::ToUInt32($image, 10)
      $bmpWidth = [BitConverter]::ToInt32($image, 18)
      $bmpHeight = [BitConverter]::ToInt32($image, 22)
      $bmpBpp = [BitConverter]::ToUInt16($image, 28)
      $bmpCompression = [BitConverter]::ToUInt32($image, 30)
      if ($bmpWidth -ne $width -or [Math]::Abs($bmpHeight) -ne $height -or $bmpBpp -ne 8 -or $bmpCompression -ne 0) {
        throw 'The HID reader returned inconsistent BMP fingerprint metadata.'
      }
      $stride = [int](($width + 3) -band -4)
      $pixelOffset = [int]$bmpOffset
      $bottomUp = $bmpHeight -gt 0
    } else {
      # Raw HID images can carry a DIB/palette prefix. The raster is at the end
      # of the blob and rows are normally DWORD-aligned. Fall back to the
      # reader-reported padding, then tightly packed rows.
      $candidateStrides = New-Object 'System.Collections.Generic.List[int]'
      $alignedStride = [int](($width + 3) -band -4)
      $candidateStrides.Add($alignedStride)
      if ($reportedPadding -ge 0 -and $reportedPadding -le 16 -and -not $candidateStrides.Contains($width + $reportedPadding)) {
        $candidateStrides.Add($width + $reportedPadding)
      }
      if (-not $candidateStrides.Contains($width)) { $candidateStrides.Add($width) }
      foreach ($candidateStride in $candidateStrides) {
        $candidateRasterLength = $candidateStride * $height
        $candidateOffset = $image.Length - $candidateRasterLength
        if ($candidateOffset -ge 0 -and $candidateOffset -le 4096) {
          $stride = $candidateStride
          $pixelOffset = $candidateOffset
          break
        }
      }
    }

    $rasterLength = $stride * $height
    if ($stride -lt $width -or $stride -gt ($width + 16) -or $pixelOffset -lt 0 -or ($pixelOffset + $rasterLength) -gt $image.Length) {
      throw "The HID reader returned an unsupported fingerprint row layout ($width x $height, $($image.Length) bytes, padding $reportedPadding)."
    }
    [byte[]]$compactImage = New-Object byte[] $expectedLength
    for ($row = 0; $row -lt $height; $row++) {
      $sourceRow = if ($bottomUp) { $height - 1 - $row } else { $row }
      [Array]::Copy($image, $pixelOffset + ($sourceRow * $stride), $compactImage, $row * $width, $width)
    }
    $image = $compactImage
  }
  return [pscustomobject]@{ Image = $image; Width = $width; Height = $height; Dpi = $xDpi }
}

function Convert-SampleToFmd {
  [OutputType([byte[]])]
  param([Parameter(Mandatory = $true)][string]$Sample)

  [byte[]]$bytes = ConvertFrom-Base64Url -Value $Sample
  for ($depth = 0; $depth -lt 5; $depth++) {
    if (Test-AnsiFmd -Bytes $bytes) { return ,$bytes }
    $parsed = ConvertBytesFromJson -Bytes $bytes
    if ($null -eq $parsed) {
      throw 'The fingerprint sample is neither a raw HID image nor an ANSI fingerprint template.'
    }
    if ($parsed -is [string]) {
      [byte[]]$bytes = ConvertFrom-Base64Url -Value $parsed
      continue
    }
    if ($parsed -is [System.Array]) {
      $items = @($parsed)
      if ($items.Count -ne 1) { throw 'The HID sample contains an unexpected number of fingerprints.' }
      $parsed = $items[0]
    }

    $raw = Get-RawImageDescriptor -Object $parsed
    if ($null -ne $raw) {
      [byte[]]$fmdBuffer = New-Object byte[] $maximumFmdBytes
      [uint32]$fmdSize = [uint32]$fmdBuffer.Length
      $returnCode = [WorkpulseFingerJetNative]::CreateFmdFromRaw(
        $raw.Image, [uint32]$raw.Image.Length, [uint32]$raw.Width, [uint32]$raw.Height,
        [uint32]$raw.Dpi, [uint32]0, [uint32]0, $ansiFmdFormat, $fmdBuffer, [ref]$fmdSize
      )
      if ($returnCode -ne 0) { throw ('FingerJet could not extract the fingerprint template (0x{0:X8}).' -f ([uint32]$returnCode)) }
      if ($fmdSize -lt 16 -or $fmdSize -gt $fmdBuffer.Length) { throw 'FingerJet returned an invalid fingerprint template size.' }
      [byte[]]$fmd = New-Object byte[] ([int]$fmdSize)
      [Array]::Copy($fmdBuffer, $fmd, [int]$fmdSize)
      if (-not (Test-AnsiFmd -Bytes $fmd)) { throw 'FingerJet returned an invalid ANSI fingerprint template.' }
      return ,$fmd
    }

    $header = Get-JsonProperty -Object $parsed -Name 'Header'
    $typeValue = if ($null -eq $header) { $null } else { Get-JsonProperty -Object $header -Name 'Type' }
    if ($null -ne $typeValue -and [int]$typeValue -ne 1) {
      throw 'The browser returned a feature sample instead of the required raw fingerprint image. Refresh WorkPulse and scan again.'
    }
    $nestedData = Get-JsonProperty -Object $parsed -Name 'Data'
    if ($nestedData -isnot [string] -or [string]::IsNullOrWhiteSpace($nestedData)) {
      throw 'The HID sample does not contain fingerprint image data.'
    }
    [byte[]]$bytes = ConvertFrom-Base64Url -Value $nestedData
  }
  throw 'The HID sample nesting is deeper than supported.'
}

function Write-FailureAndExit {
  param([Parameter(Mandatory = $true)][string]$Message)
  [Console]::Error.WriteLine($Message)
  exit 1
}

try {
  if (-not (Test-Path -LiteralPath $fingerJetPath -PathType Leaf)) { throw "FingerJet runtime is not installed at $fingerJetPath." }
  if (-not ('WorkpulseFingerJetNative' -as [type])) {
    $nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class WorkpulseFingerJetNative
{
    [DllImport(@"C:\Windows\System32\dpfj.dll", EntryPoint = "dpfj_create_fmd_from_raw", ExactSpelling = true, CallingConvention = CallingConvention.Cdecl)]
    public static extern int CreateFmdFromRaw(
        [In] byte[] imageData, uint imageSize, uint imageWidth, uint imageHeight,
        uint imageDpi, uint fingerPosition, uint cbeffId, int fmdType,
        [Out] byte[] fmd, ref uint fmdSize);

    [DllImport(@"C:\Windows\System32\dpfj.dll", EntryPoint = "dpfj_compare", ExactSpelling = true, CallingConvention = CallingConvention.Cdecl)]
    public static extern int Compare(
        int fmd1Type, [In] byte[] fmd1, uint fmd1Size, uint fmd1ViewIndex,
        int fmd2Type, [In] byte[] fmd2, uint fmd2Size, uint fmd2ViewIndex,
        out uint score);
}
'@
    $null = Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
  }

  $requestText = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($requestText)) { throw 'Fingerprint matcher input is empty.' }
  if ($requestText.Length -gt 20MB) { throw 'Fingerprint matcher input is too large.' }
  $request = ConvertFrom-Json -InputObject $requestText -ErrorAction Stop
  $operationValue = Get-JsonProperty -Object $request -Name 'operation'
  $operation = if ($operationValue -is [string]) { $operationValue.ToLowerInvariant() } else { 'compare' }

  if ($operation -eq 'extract') {
    $sampleValue = Get-JsonProperty -Object $request -Name 'samples'
    if ($null -eq $sampleValue) { throw 'Fingerprint extraction samples are missing.' }
    $samples = @($sampleValue)
    if ($samples.Count -lt 1 -or $samples.Count -gt 8) { throw 'Fingerprint extraction sample count is invalid.' }
    $templates = foreach ($sample in $samples) {
      if ($sample -isnot [string]) { throw 'Fingerprint extraction sample is invalid.' }
      [byte[]]$fmd = Convert-SampleToFmd -Sample $sample
      ConvertTo-Base64Url -Value $fmd
    }
    [Console]::Out.WriteLine(([pscustomobject][ordered]@{ templates = @($templates); format = 'DPFJ_FMD_ANSI_378_2004' } | ConvertTo-Json -Compress -Depth 4))
    exit 0
  }

  if ($operation -ne 'compare') { throw 'Unknown fingerprint matcher operation.' }
  $probeValue = Get-JsonProperty -Object $request -Name 'probe'
  if ($probeValue -isnot [string]) { throw 'Fingerprint matcher probe is missing.' }
  [byte[]]$probeFmd = Convert-SampleToFmd -Sample $probeValue
  $candidateValue = Get-JsonProperty -Object $request -Name 'candidates'
  if ($null -eq $candidateValue) { throw 'Fingerprint matcher candidates are missing.' }
  $candidates = @($candidateValue)
  if ($candidates.Count -gt 10000) { throw 'Fingerprint matcher candidate limit exceeded.' }

  $results = New-Object 'System.Collections.Generic.List[object]'
  $overallBest = $null
  foreach ($candidate in $candidates) {
    $employeeId = [string](Get-JsonProperty -Object $candidate -Name 'employeeId')
    if ([string]::IsNullOrWhiteSpace($employeeId)) { throw 'Fingerprint candidate has no employeeId.' }
    $sampleValue = Get-JsonProperty -Object $candidate -Name 'samples'
    [object[]]$samples = @()
    if ($null -ne $sampleValue) { $samples = @($sampleValue) }
    $candidateBest = $null
    $lastError = $null

    for ($sampleIndex = 0; $sampleIndex -lt $samples.Count; $sampleIndex++) {
      if ($samples[$sampleIndex] -isnot [string]) { $lastError = 'Candidate fingerprint sample is invalid.'; continue }
      try { [byte[]]$candidateFmd = Convert-SampleToFmd -Sample ([string]$samples[$sampleIndex]) }
      catch { $lastError = $_.Exception.Message; continue }
      [uint32]$score = 0
      $returnCode = [WorkpulseFingerJetNative]::Compare(
        $ansiFmdFormat, $probeFmd, [uint32]$probeFmd.Length, [uint32]0,
        $ansiFmdFormat, $candidateFmd, [uint32]$candidateFmd.Length, [uint32]0, [ref]$score
      )
      if ($returnCode -ne 0) { $lastError = ('FingerJet comparison failed (0x{0:X8}).' -f ([uint32]$returnCode)); continue }
      if ($null -eq $candidateBest -or [uint64]$score -lt [uint64]$candidateBest.score) {
        $candidateBest = [pscustomobject][ordered]@{ employeeId = $employeeId; score = [int64]$score; format = 'DPFJ_FMD_ANSI_378_2004'; sampleIndex = $sampleIndex }
      }
    }

    if ($null -eq $candidateBest) {
      $failureMessage = if ([string]::IsNullOrWhiteSpace($lastError)) { 'Candidate has no fingerprint samples.' } else { $lastError }
      $results.Add([pscustomobject][ordered]@{ employeeId = $employeeId; score = $maximumDissimilarity; format = $null; sampleIndex = $null; error = $failureMessage })
      continue
    }
    $results.Add($candidateBest)
    if ($null -eq $overallBest -or [int64]$candidateBest.score -lt [int64]$overallBest.score) { $overallBest = $candidateBest }
  }

  [Console]::Out.WriteLine(([pscustomobject][ordered]@{ results = $results.ToArray(); best = $overallBest } | ConvertTo-Json -Compress -Depth 6))
} catch {
  Write-FailureAndExit -Message $_.Exception.Message
}
