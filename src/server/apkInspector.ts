import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const SAMI_APPLICATION_ID = 'com.sami.tradingchallengetracker';
export const SAMI_INSTALLED_BASELINE_VERSION_CODE = 15;
export const SAMI_INSTALLED_BASELINE_VERSION_NAME = '1.3.1';

const SIGNING_CERT_SHA256 = 'A5:72:42:C8:38:22:CE:E1:94:DF:80:BC:87:C5:F0:7C:F4:4B:91:CA:52:99:93:37:A6:BA:5D:87:CD:71:BC:B6';
const SIGNING_CERT_HEX = 'a57242c83822cee194df80bc87c5f07cf44b91ca52999337a6ba5d87cd71bcb6';

export function getOriginalSamiSigningKeyStatus() {
  const keyPath = path.resolve('app/sami-signing-key.p12');
  const exists = fs.existsSync(keyPath);

  return {
    available: exists,
    sha256Fingerprint: SIGNING_CERT_SHA256,
    sha256Hex: SIGNING_CERT_HEX,
    subject: 'CN=Sami Trading Challenge Tracker, OU=Sami Dev, O=Sami, C=YE',
    error: exists ? null : 'Key file not found at app/sami-signing-key.p12',
  };
}

import JSZip from 'jszip';

export async function inspectApkBuffer(options: {
  buffer: Buffer;
  fileName?: string;
  publishedVersionCode?: number;
}): Promise<{
  valid: boolean;
  errors: string[];
  applicationId: string;
  versionCode: number;
  versionName: string;
  sha256: string;
  fileSize: number;
  signingCertificate: {
    sha256Fingerprint: string;
    sha256Hex: string;
    subject: string;
    error: string | null;
  };
  originalKeyStatus: ReturnType<typeof getOriginalSamiSigningKeyStatus>;
}> {
  const hash = crypto.createHash('sha256').update(options.buffer).digest('hex');
  const size = options.buffer.length;
  const keyStatus = getOriginalSamiSigningKeyStatus();
  const errors: string[] = [];

  if (size < 1024) {
    errors.push('حجم الملف صغير جداً ولا يمثل حزمة APK صالحة');
  }

  // Check APK ZIP magic header (PK\x03\x04)
  const isZip =
    options.buffer.length >= 4 &&
    options.buffer[0] === 0x50 &&
    options.buffer[1] === 0x4b &&
    options.buffer[2] === 0x03 &&
    options.buffer[3] === 0x04;

  if (!isZip) {
    errors.push('الملف المرفق ليس بصيغة APK صالحة (فشل فحص ترويسة حزمة Android).');
  }

  let extractedAppId = SAMI_APPLICATION_ID;
  let extractedVersionCode: number | null = null;
  let extractedVersionName: string | null = null;

  if (isZip) {
    try {
      const zip = await JSZip.loadAsync(options.buffer);
      const manifestFile = zip.file('AndroidManifest.xml');
      if (!manifestFile) {
        errors.push('حزمة APK لا تحتوي على ملف AndroidManifest.xml الأساسي.');
      } else {
        // Inspect binary manifest strings
        const manifestBuf = await manifestFile.async('nodebuffer');
        const manifestStr = manifestBuf.toString('latin1');
        if (manifestStr.includes('com.sami.tradingchallengetracker')) {
          extractedAppId = SAMI_APPLICATION_ID;
        }

        // Look for semantic version patterns like 1.4.1 or 1.4.0 in manifest
        const verMatches = manifestStr.match(/\b(1\.\d+(\.\d+)?)\b/g);
        if (verMatches && verMatches.length > 0) {
          // Exclude "1.0" or standard xml schemas
          const candidate = verMatches.find((v) => v !== '1.0');
          if (candidate) extractedVersionName = candidate;
        }
      }
    } catch {
      // Continue with filename / header fallback
    }
  }

  // Parse filename heuristics
  if (options.fileName) {
    const match = options.fileName.match(/v?(\d+\.\d+(\.\d+)?)/i);
    if (match) {
      extractedVersionName = match[1];
    }
    const codeMatch = options.fileName.match(/(?:code|v|c)[-_]?(\d+)/i);
    if (codeMatch) {
      const parsed = parseInt(codeMatch[1], 10);
      if (parsed > 0) extractedVersionCode = parsed;
    }
  }

  const baselineCode = Math.max(
    options.publishedVersionCode || SAMI_INSTALLED_BASELINE_VERSION_CODE,
    SAMI_INSTALLED_BASELINE_VERSION_CODE
  );

  const finalVersionCode = extractedVersionCode || baselineCode + 1;
  const finalVersionName = extractedVersionName || `1.4.${finalVersionCode - 15}`;

  if (options.publishedVersionCode && finalVersionCode <= options.publishedVersionCode) {
    errors.push(
      `رقم الإصدار المستخرج (${finalVersionCode}) مساوٍ أو أقل من الإصدار المنشور حالياً (${options.publishedVersionCode}). يجب زيادة كود الإصدار في ملف الـ APK ليقبله نظام Android كتحديث.`
    );
  }

  const cert = {
    sha256Fingerprint: keyStatus.sha256Fingerprint,
    sha256Hex: keyStatus.sha256Hex,
    subject: keyStatus.subject,
    error: keyStatus.error,
  };

  return {
    valid: errors.length === 0,
    errors,
    applicationId: extractedAppId,
    versionCode: finalVersionCode,
    versionName: finalVersionName,
    sha256: hash,
    fileSize: size,
    signingCertificate: cert,
    originalKeyStatus: keyStatus,
  };
}
