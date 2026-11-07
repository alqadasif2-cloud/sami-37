import React, { useState, useEffect, useRef, useCallback } from './samiReactShim.ts';
import {
  SAMI_EXPECTED_APP_ID,
  SAMI_FALLBACK_VERSION_CODE,
  SAMI_FALLBACK_VERSION_NAME,
  CloudAppUpdateConfig,
  InstalledAppInfo,
  ClientApkInspection,
  isAndroidLocalAssetOrigin,
  sanitizeProductionServerUrl,
  getSamiServerBaseUrl,
  getInstalledSamiAppInfo,
  fetchJsonApi,
  getAuthCredentials,
  translateNetworkOrHttpErrorAr,
  formatBytesAr,
  formatSpeedAr,
  computeArrayBufferSha256Hex,
  GoldProgressBar,
  SamiUserUpdateModal,
} from './samiCloudUpdater.tsx';

const CHUNK_SIZE = 1024 * 1024; // 1 MB chunk size for reliable weak-network transfers

export function SamiAdminFirebaseUpdatePanel({
  currentUser,
  onToast,
}: {
  currentUser: any;
  onToast?: (msg: string, isError?: boolean) => void;
}) {
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const notify = useCallback((msg: string, isError = false) => {
    if (onToastRef.current) onToastRef.current(msg, isError);
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const unmountAbortRef = useRef<AbortController | null>(null);
  const inFlightBootstrapRef = useRef(false);
  const mountedRef = useRef(true);

  // Upload controller ref for pause, resume, cancel, and offline recovery
  const uploadCtrlRef = useRef<{
    aborted: boolean;
    paused: boolean;
    uploadId: string;
  } | null>(null);

  // General state
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [connectionErrorAr, setConnectionErrorAr] = useState<string | null>(null);
  const [signingKeyInfo, setSigningKeyInfo] = useState<any>(null);
  const [currentPublished, setCurrentPublished] = useState<CloudAppUpdateConfig | null>(null);
  const [effectiveMinVersionCode, setEffectiveMinVersionCode] = useState<number>(SAMI_FALLBACK_VERSION_CODE);
  const [historyList, setHistoryList] = useState<CloudAppUpdateConfig[]>([]);

  // Global Distribution Switch
  const [globalDistributionEnabled, setGlobalDistributionEnabled] = useState(true);
  const [togglingGlobal, setTogglingGlobal] = useState(false);

  // File Attachment & Inspection State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspectingFile, setInspectingFile] = useState(false);
  const [inspection, setInspection] = useState<ClientApkInspection | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Release Metadata Form State
  const [description, setDescription] = useState('');
  const [isMandatory, setIsMandatory] = useState(false);

  // Upload Progress & Weak Network Resilience State
  const [uploading, setUploading] = useState(false);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadTotalBytes, setUploadTotalBytes] = useState(0);
  const [uploadSpeedBps, setUploadSpeedBps] = useState(0);
  const [uploadPhaseText, setUploadPhaseText] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccessInfo, setUploadSuccessInfo] = useState<any>(null);
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);

  // History action state
  const [actionBusy, setActionBusy] = useState(false);
  const [togglingUpdateId, setTogglingUpdateId] = useState<string | number | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const installedApp = getInstalledSamiAppInfo();

  // Listen for online / offline network state changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      setIsOffline(false);
      notify('تم استعادة الاتصال بالإنترنت 📶', false);
    };
    const handleOffline = () => {
      setIsOffline(true);
      notify('انقطع الاتصال بالإنترنت — تم حفظ الملف والتقدم مؤقتاً ⚠️', true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [notify]);

  const resolveCallableServerBase = useCallback(async (): Promise<{ serverBase: string }> => {
    if (!isAndroidLocalAssetOrigin()) {
      return { serverBase: '' };
    }
    const cached = getSamiServerBaseUrl();
    if (cached) return { serverBase: cached };
    return { serverBase: '' };
  }, []);

  const loadCloudStatusAndHistory = useCallback(
    async (opts?: { showToastOnError?: boolean }) => {
      if (inFlightBootstrapRef.current) return;
      inFlightBootstrapRef.current = true;
      setLoadingStatus(true);
      setConnectionErrorAr(null);

      const signal = unmountAbortRef.current?.signal;
      try {
        const { serverBase } = await resolveCallableServerBase();
        const { headers } = getAuthCredentials();
        const { ok, status, data } = await fetchJsonApi(
          `${serverBase}/api/app-updates/admin-bootstrap?_t=${Date.now()}`,
          {
            method: 'GET',
            headers,
            timeoutMs: 15_000,
            parentSignal: signal,
          }
        );

        if (!mountedRef.current || signal?.aborted) return;

        if (!ok || !data?.success) {
          const errText = translateNetworkOrHttpErrorAr(null, status, data?.error);
          setConnectionState('error');
          setConnectionErrorAr(errText);
          if (opts?.showToastOnError) {
            notify(errText, true);
          }
          return;
        }

        setSigningKeyInfo(data.signingKey || null);
        setCurrentPublished(data.currentPublished || null);
        setEffectiveMinVersionCode(Number(data.effectiveMinVersionCode) || SAMI_FALLBACK_VERSION_CODE);
        if (Array.isArray(data.updates)) {
          setHistoryList(data.updates);
        }
        if (typeof data.globalDistributionEnabled === 'boolean') {
          setGlobalDistributionEnabled(data.globalDistributionEnabled);
        }

        setConnectionState('connected');
        setConnectionErrorAr(null);
      } catch (err: any) {
        if (err?.isCancelled || !mountedRef.current || signal?.aborted) return;
        const errText = translateNetworkOrHttpErrorAr(err);
        setConnectionState('error');
        setConnectionErrorAr(errText);
        if (opts?.showToastOnError) {
          notify(errText, true);
        }
      } finally {
        inFlightBootstrapRef.current = false;
        if (mountedRef.current) {
          setLoadingStatus(false);
        }
      }
    },
    [notify, resolveCallableServerBase]
  );

  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    unmountAbortRef.current = ctrl;

    loadCloudStatusAndHistory({ showToastOnError: false });

    return () => {
      mountedRef.current = false;
      ctrl.abort();
    };
  }, [loadCloudStatusAndHistory]);

  const handleChooseApkClick = () => {
    if (uploading) return;
    fileInputRef.current?.click();
  };

  const handleClearSelectedFile = () => {
    if (uploading) return;
    setSelectedFile(null);
    setInspection(null);
    setLocalError(null);
    setUploadError(null);
    setUploadSuccessInfo(null);
    setUploadPercent(0);
    setUploadedBytes(0);
    setUploadPhaseText('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const inspectSelectedApk = async (file: File) => {
    setSelectedFile(file);
    setInspection(null);
    setLocalError(null);
    setUploadError(null);
    setUploadSuccessInfo(null);

    if (!file.name.toLowerCase().endsWith('.apk')) {
      const msg = 'يرجى إرفاق ملف بصيغة .apk فقط. تم رفض الملف المختار.';
      setLocalError(msg);
      notify(msg, true);
      return;
    }

    if (file.size <= 64) {
      const msg = 'ملف الـ APK المرفق فارغ أو تالف.';
      setLocalError(msg);
      notify(msg, true);
      return;
    }

    setInspectingFile(true);
    const signal = unmountAbortRef.current?.signal;
    try {
      const arrayBuf = await file.arrayBuffer();
      const localSha256 = await computeArrayBufferSha256Hex(arrayBuf);

      const { serverBase } = await resolveCallableServerBase();
      const { headers } = getAuthCredentials();
      const { data, status } = await fetchJsonApi(`${serverBase}/api/app-updates/inspect-apk`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/vnd.android.package-archive',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
        timeoutMs: 60_000,
        parentSignal: signal,
      });

      if (!mountedRef.current || signal?.aborted) return;

      if (data?.inspection) {
        const srvInsp: ClientApkInspection = {
          ...data.inspection,
          sha256: data.inspection.sha256 || localSha256,
        };
        setInspection(srvInsp);

        if (!srvInsp.canPublish && srvInsp.errors?.length > 0) {
          setLocalError(srvInsp.errors[0]);
          notify(srvInsp.errors[0], true);
        } else {
          if (!description.trim()) {
            setDescription(`تحديث تطبيق Sami الإصدار ${srvInsp.versionName} — تحسينات في الأداء والاستقرار.`);
          }
          notify(`تم فحص حزمة APK بنجاح (v${srvInsp.versionName} - كود ${srvInsp.versionCode}) ✅`);
        }
      } else {
        const errMsg = translateNetworkOrHttpErrorAr(null, status, data?.error || 'تعذر قراءة بيانات حزمة APK المرفقة');
        setLocalError(errMsg);
        notify(errMsg, true);
      }
    } catch (err: any) {
      if (err?.isCancelled || !mountedRef.current) return;
      const msg = translateNetworkOrHttpErrorAr(err);
      setLocalError(msg);
      notify(msg, true);
    } finally {
      if (mountedRef.current) {
        setInspectingFile(false);
      }
    }
  };

  const handleFileInputChange = (e: any) => {
    const file: File | undefined = e.target?.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    inspectSelectedApk(file);
  };

  // Resilient Chunked Upload Engine to Firebase Storage
  const handleStartFirebaseUpload = async (resumeExisting = false) => {
    if (!selectedFile || !inspection) {
      notify('يرجى إرفاق ملف APK صالح أولاً', true);
      return;
    }
    if (!inspection.canPublish) {
      notify(inspection.errors[0] || 'لا يمكن نشر هذا الملف لوجود تعارض في كود الإصدار أو التوقيع', true);
      return;
    }
    if (!description.trim()) {
      notify('يرجى كتابة وصف مختصر للتحديث قبل النشر', true);
      return;
    }

    const signal = unmountAbortRef.current?.signal;
    const { serverBase } = await resolveCallableServerBase();

    // Stable uploadId based on file name, size, and version code so resume finds the exact staging file
    const safeName = selectedFile.name.replace(/[^a-zA-Z0-9]/g, '_');
    const targetUploadId =
      resumeExisting && uploadCtrlRef.current?.uploadId
        ? uploadCtrlRef.current.uploadId
        : `fb_up_${inspection.versionCode}_${selectedFile.size}_${safeName}`;

    uploadCtrlRef.current = {
      aborted: false,
      paused: false,
      uploadId: targetUploadId,
    };

    setUploading(true);
    setUploadPaused(false);
    setUploadError(null);
    setUploadSuccessInfo(null);
    setUploadTotalBytes(selectedFile.size);
    setUploadPhaseText('جارٍ الاتصال وفحص نقطة استئناف الرفع في Firebase...');

    const { headers: authHeaders } = getAuthCredentials();

    // 1. Query server upload status for existing byte offset (Resumable Upload)
    let offset = 0;
    try {
      const statusRes = await fetchJsonApi(
        `${serverBase}/api/app-updates/upload-status/${encodeURIComponent(targetUploadId)}?_t=${Date.now()}`,
        {
          method: 'GET',
          headers: authHeaders,
          timeoutMs: 10_000,
          parentSignal: signal,
        }
      );
      if (statusRes.ok && statusRes.data?.exists && typeof statusRes.data?.uploadedBytes === 'number') {
        const serverBytes = statusRes.data.uploadedBytes;
        if (serverBytes > 0 && serverBytes <= selectedFile.size) {
          offset = serverBytes;
          setUploadedBytes(offset);
          const resumePct = Math.min(95, Math.floor((offset * 95) / selectedFile.size));
          setUploadPercent(resumePct);
          setUploadPhaseText(
            `تم العثور على نقطة استئناف سابقة (${formatBytesAr(offset)} من ${formatBytesAr(selectedFile.size)}) — جارٍ المتابعة...`
          );
        }
      }
    } catch {
      // If status check fails, proceed from 0
    }

    let speedStartMs = Date.now();
    let speedStartBytes = offset;

    // 2. Chunk-by-Chunk Upload Loop with Pause & Weak Internet Auto-Retry
    while (offset < selectedFile.size) {
      if (uploadCtrlRef.current?.aborted) {
        setUploading(false);
        setUploadPhaseText('تم إلغاء عملية الرفع بناءً على طلبك.');
        return;
      }

      if (uploadCtrlRef.current?.paused) {
        setUploading(false);
        setUploadPaused(true);
        setUploadPhaseText(
          `تم إيقاف الرفع مؤقتاً عند ${formatBytesAr(offset)} من ${formatBytesAr(selectedFile.size)}.`
        );
        return;
      }

      const chunkEnd = Math.min(selectedFile.size, offset + CHUNK_SIZE);
      const chunkBlob = selectedFile.slice(offset, chunkEnd);
      const chunkSize = chunkBlob.size;

      let chunkSuccess = false;
      let retryAttempt = 0;
      const maxRetries = 10;

      while (!chunkSuccess && retryAttempt < maxRetries) {
        if (uploadCtrlRef.current?.aborted || uploadCtrlRef.current?.paused) break;

        // Weak internet check: if offline, wait until online
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setUploadPhaseText(
            'انقطع الاتصال بالإنترنت مؤقتاً — تم حفظ الملف والتقدم وسنستأنف الرفع تلقائياً عند عودة الشبكة...'
          );
          await new Promise((res) => {
            const onOnline = () => {
              window.removeEventListener('online', onOnline);
              res(true);
            };
            window.addEventListener('online', onOnline, { once: true });
            setTimeout(res, 4000);
          });
          continue;
        }

        try {
          const chunkRes = await fetch(`${serverBase}/api/app-updates/upload-chunk`, {
            method: 'POST',
            headers: {
              ...authHeaders,
              'Content-Type': 'application/octet-stream',
              'X-Upload-Id': targetUploadId,
              'X-Offset': String(offset),
              'X-Total-Size': String(selectedFile.size),
              'X-Chunk-Size': String(chunkSize),
            },
            body: chunkBlob,
            signal: signal,
          });

          if (!chunkRes.ok) {
            const errData = await chunkRes.json().catch(() => ({}));
            throw new Error(errData?.error || `فشل رفع الجزء (HTTP ${chunkRes.status})`);
          }

          chunkSuccess = true;
        } catch (err: any) {
          retryAttempt++;
          const backoffMs = Math.min(6000, 1500 * Math.pow(1.4, retryAttempt));
          setUploadPhaseText(
            `ضعف في الاتصال بالإنترنت (محاولة ${retryAttempt} من ${maxRetries}) — جارٍ إعادة المحاولة تلقائياً...`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      if (!chunkSuccess) {
        setUploading(false);
        const errMsg =
          'تعذر استكمال رفع التحديث نظراً لضعف اتصال الإنترنت. تم حفظ النسبة المرفوعة محلياً ويمكنك الضغط على «استئناف الرفع» للمتابعة.';
        setUploadError(errMsg);
        setUploadPhaseText('توقف الرفع مؤقتاً لضعف الاتصال');
        notify(errMsg, true);
        return;
      }

      offset += chunkSize;
      setUploadedBytes(offset);

      const now = Date.now();
      if (now - speedStartMs >= 400) {
        const bps = Math.round(((offset - speedStartBytes) * 1000) / (now - speedStartMs));
        setUploadSpeedBps(Math.max(0, bps));
        speedStartMs = now;
        speedStartBytes = offset;
      }

      const currentPct = Math.min(95, Math.floor((offset * 95) / selectedFile.size));
      setUploadPercent(currentPct);
      setUploadPhaseText(
        `جارٍ رفع ملف الـ APK إلى Firebase Storage (${Math.round((offset * 100) / selectedFile.size)}%)...`
      );
    }

    // 3. Finalize and Publish in Firebase Firestore & Storage
    setUploadSpeedBps(0);
    setUploadPercent(96);
    setUploadPhaseText('اكتمل نقل الملف — جارٍ فحص الحزمة وحفظ الإصدار في Firebase Firestore...');

    try {
      const { ok, status, data } = await fetchJsonApi(`${serverBase}/api/app-updates/publish-firebase`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uploadId: targetUploadId,
          fileName: selectedFile.name,
          expectedSha256: inspection.sha256,
          description: description.trim(),
          isMandatory,
        }),
        timeoutMs: 60_000,
        parentSignal: signal,
      });

      if (!ok || !data?.success) {
        throw new Error(translateNetworkOrHttpErrorAr(null, status, data?.error || 'تعذر اعتماد ونشر التحديث'));
      }

      setUploadPercent(100);
      setUploadPhaseText('اكتمل النشر بنجاح وحفظ التحديث في Firebase Storage وFirestore (100%)');
      setUploadSuccessInfo(data);
      setCurrentPublished(data.update);
      setSelectedFile(null);
      setInspection(null);
      setDescription('');
      notify(data.message || 'تم نشر التحديث بنجاح وأصبح متاحاً لجميع مستخدمي Sami 🚀');
      loadCloudStatusAndHistory({ showToastOnError: false });
    } catch (pubErr: any) {
      const msg = translateNetworkOrHttpErrorAr(pubErr);
      setUploadError(msg);
      setUploadPhaseText('فشل تسجيل التحديث في Firebase');
      notify(msg, true);
    } finally {
      setUploading(false);
    }
  };

  const handlePauseUpload = () => {
    if (uploadCtrlRef.current) {
      uploadCtrlRef.current.paused = true;
    }
    setUploadPaused(true);
    setUploading(false);
    setUploadPhaseText('تم إيقاف الرفع مؤقتاً');
    notify('تم إيقاف رفع التحديث مؤقتاً');
  };

  const handleResumeUpload = () => {
    handleStartFirebaseUpload(true);
  };

  const handleCancelUpload = () => {
    if (uploadCtrlRef.current) {
      uploadCtrlRef.current.aborted = true;
    }
    setUploading(false);
    setUploadPaused(false);
    setUploadPercent(0);
    setUploadedBytes(0);
    setUploadSpeedBps(0);
    setUploadPhaseText('تم إلغاء عملية الرفع');
    setSelectedFile(null);
    setInspection(null);
    setUploadError(null);
    notify('تم إلغاء رفع التحديث');
  };

  const handleToggleGlobalDistribution = async () => {
    if (togglingGlobal) return;
    setTogglingGlobal(true);
    const signal = unmountAbortRef.current?.signal;
    try {
      const { serverBase } = await resolveCallableServerBase();
      const { headers } = getAuthCredentials();
      const nextState = !globalDistributionEnabled;
      const { ok, status, data } = await fetchJsonApi(`${serverBase}/api/app-updates/global-distribution`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState }),
        timeoutMs: 15_000,
        parentSignal: signal,
      });
      if (!mountedRef.current || signal?.aborted) return;
      if (!ok || !data.success) {
        throw new Error(translateNetworkOrHttpErrorAr(null, status, data.error || 'تعذر تغيير مفتاح التوزيع الشامل'));
      }
      setGlobalDistributionEnabled(data.globalDistributionEnabled);
      notify(
        data.message ||
          (nextState
            ? 'تم تفعيل التوزيع الشامل لكافة التحديثات ✅'
            : 'تم إيقاف التوزيع الشامل لكافة التحديثات مؤقتاً ⏸️')
      );
      loadCloudStatusAndHistory({ showToastOnError: false });
    } catch (err: any) {
      if (err?.isCancelled || !mountedRef.current) return;
      notify(translateNetworkOrHttpErrorAr(err), true);
    } finally {
      if (mountedRef.current) {
        setTogglingGlobal(false);
      }
    }
  };

  const handleToggleIndividualUpdate = async (item: CloudAppUpdateConfig) => {
    const targetId = item.id || item.updateId || item.versionCode;
    if (togglingUpdateId) return;
    setTogglingUpdateId(targetId);
    const signal = unmountAbortRef.current?.signal;
    try {
      const { serverBase } = await resolveCallableServerBase();
      const { headers } = getAuthCredentials();
      const isCurrentlyActive = item.isActive !== false && item.distributionStatus !== 'disabled';
      const nextStatus = isCurrentlyActive ? 'disabled' : 'enabled';
      const { ok, status, data } = await fetchJsonApi(`${serverBase}/api/app-updates/distribution-status`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updateId: targetId,
          versionCode: item.versionCode,
          distributionStatus: nextStatus,
        }),
        timeoutMs: 15_000,
        parentSignal: signal,
      });
      if (!mountedRef.current || signal?.aborted) return;
      if (!ok || !data.success) {
        throw new Error(translateNetworkOrHttpErrorAr(null, status, data.error || 'تعذر تغيير حالة توزيع التحديث'));
      }
      notify(data.message || 'تم تحديث حالة توزيع الإصدار بنجاح ✅');
      loadCloudStatusAndHistory({ showToastOnError: false });
    } catch (err: any) {
      if (err?.isCancelled || !mountedRef.current) return;
      notify(translateNetworkOrHttpErrorAr(err), true);
    } finally {
      if (mountedRef.current) {
        setTogglingUpdateId(null);
      }
    }
  };

  const handleRollbackToVersion = async (targetVersionCode: number) => {
    if (actionBusy) return;
    setActionBusy(true);
    const signal = unmountAbortRef.current?.signal;
    try {
      const { serverBase } = await resolveCallableServerBase();
      const { headers } = getAuthCredentials();
      const { ok, status, data } = await fetchJsonApi(`${serverBase}/api/app-updates/rollback`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionCode: targetVersionCode }),
        timeoutMs: 20_000,
        parentSignal: signal,
      });
      if (!mountedRef.current || signal?.aborted) return;
      if (!ok || !data.success) {
        throw new Error(translateNetworkOrHttpErrorAr(null, status, data.error || 'تعذر الرجوع إلى الإصدار المحدد'));
      }
      setCurrentPublished(data.update);
      notify(data.message || 'تم الرجوع إلى الإصدار السابق بنجاح');
      loadCloudStatusAndHistory({ showToastOnError: false });
    } catch (err: any) {
      if (err?.isCancelled || !mountedRef.current) return;
      notify(translateNetworkOrHttpErrorAr(err), true);
    } finally {
      if (mountedRef.current) {
        setActionBusy(false);
      }
    }
  };

  const isCurrentActive = Boolean(
    currentPublished && currentPublished.isActive === true && !currentPublished.isHidden
  );

  return (
    <div dir="rtl" className="space-y-4 text-right">
      {/* 0. Global Distribution Switch Card */}
      <div className="bg-[#121824] border border-amber-400/40 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1 max-w-xl">
          <div className="flex items-center gap-2">
            <span className="text-base font-black text-amber-300">مفتاح التحكم الشامل في توزيع التحديثات</span>
            <span
              className={`text-[10px] font-black px-2.5 py-0.5 rounded-full border ${
                globalDistributionEnabled
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
              }`}
            >
              {globalDistributionEnabled ? 'التوزيع الشامل مفعّل ✓' : 'التوزيع الشامل معطّل ✗'}
            </span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            {globalDistributionEnabled
              ? 'تصل إشعارات التحديثات المنشورة تلقائياً لجميع المستخدمين الذين يستخدمون إصداراً أقدم من التطبيق.'
              : 'تم إيقاف توزيع كافة التحديثات مؤقتاً. لن تظهر نافذة التحديث لأي مستخدم مع الحفاظ على كافة السجلات.'}
          </p>
        </div>

        <button
          type="button"
          disabled={togglingGlobal || loadingStatus}
          onClick={handleToggleGlobalDistribution}
          className={`shrink-0 px-4 py-2.5 rounded-xl font-black text-xs border transition cursor-pointer disabled:opacity-50 ${
            globalDistributionEnabled
              ? 'bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/40 text-rose-300'
              : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
          }`}
        >
          {togglingGlobal
            ? 'جارٍ تغيير الحالة...'
            : globalDistributionEnabled
              ? '⏸️ إيقاف التوزيع الشامل للتحديثات'
              : '▶️ تفعيل التوزيع الشامل للتحديثات'}
        </button>
      </div>

      {/* 1. Firebase System Status Card */}
      <div className="bg-[#121824] border border-amber-500/40 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-black text-amber-300">
              نظام نشر وتوزيع التحديثات عبر Firebase (Storage & Firestore)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              تخزين ملفات APK في Firebase Storage وتسجيل بيانات الإصدار في Cloud Firestore مباشرة
            </p>
          </div>
          <button
            type="button"
            disabled={loadingStatus}
            onClick={() => loadCloudStatusAndHistory({ showToastOnError: true })}
            className="px-3 py-1.5 rounded-lg bg-[#0b0f17] hover:bg-slate-800 border border-slate-700 text-[11px] font-bold text-amber-300 transition cursor-pointer disabled:opacity-50"
          >
            {loadingStatus ? 'جارٍ التحديث...' : 'تحديث الحالة'}
          </button>
        </div>

        {connectionState === 'error' && connectionErrorAr && (
          <div className="rounded-xl p-3.5 border text-xs space-y-2 bg-rose-500/10 border-rose-500/40 text-rose-200">
            <div className="flex items-center justify-between gap-2">
              <span className="font-black">تنبيه اتصال بالخادم</span>
              <button
                type="button"
                disabled={loadingStatus}
                onClick={() => loadCloudStatusAndHistory({ showToastOnError: true })}
                className="shrink-0 px-3 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-[11px] transition cursor-pointer disabled:opacity-50"
              >
                إعادة المحاولة
              </button>
            </div>
            <p className="text-[11px] leading-relaxed">{connectionErrorAr}</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
          <div className="bg-[#0b0f17] p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">حاوية التخزين (Storage Bucket):</span>
            <span dir="ltr" className="font-bold font-['JetBrains_Mono',monospace] text-emerald-400 truncate text-[11px]">
              majestic-interface-ksmzh.firebasestorage.app
            </span>
          </div>

          <div className="bg-[#0b0f17] p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">قاعدة البيانات (Firestore):</span>
            <span className="font-black text-emerald-400">
              متصلة (مجموعة app_updates) ✓
            </span>
          </div>

          <div className="bg-[#0b0f17] p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">النسخة المثبتة على جهازك:</span>
            <span dir="ltr" className="font-bold text-slate-200 font-['JetBrains_Mono',monospace] tabular-nums">
              v{installedApp.versionName} (Build {installedApp.versionCode})
            </span>
          </div>

          <div className="bg-[#0b0f17] p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <span className="text-slate-400">آخر تحديث منشور في Firebase:</span>
            <span className={`font-black ${isCurrentActive ? 'text-emerald-400' : 'text-slate-400'}`}>
              {isCurrentActive && currentPublished
                ? `v${currentPublished.versionName} (Build ${currentPublished.versionCode})`
                : 'لا يوجد تحديث منشور حالياً'}
            </span>
          </div>
        </div>

        {signingKeyInfo && (
          <div className="bg-[#0b0f17] border border-slate-800 rounded-xl p-3 text-[11px] space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 font-bold">شهادة توقيع تطبيق Sami المعتمدة:</span>
              <span className={signingKeyInfo.available ? 'text-emerald-400 font-black' : 'text-rose-400 font-black'}>
                {signingKeyInfo.available ? 'متوفرة ومطابقة ✓' : 'مفقودة ✗'}
              </span>
            </div>
            {signingKeyInfo.sha256Fingerprint && (
              <div dir="ltr" className="text-[10px] text-slate-400 font-['JetBrains_Mono',monospace] break-all">
                SHA-256: {signingKeyInfo.sha256Fingerprint}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. CHAT-LIKE APK ATTACHMENT & PUBLISHING CARD */}
      <div className="bg-[#121824] border border-amber-400/40 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black text-amber-300">
              إرفاق ونشر ملف APK مباشرة عبر Firebase
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              اختر ملف APK من جهازك أو هاتفك كما تختار ملفاً في المحادثة، ثم اضغط «نشر التحديث» ليصبح متاحاً للمستخدمين فوراً.
            </p>
          </div>
          {currentUser?.displayName && (
            <span className="text-[11px] text-slate-400">المسؤول: {currentUser.displayName}</span>
          )}
        </div>

        {/* Hidden Native File Input (Accepts .apk from PC and Mobile Android) */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* State A: No file attached -> Large Attachment Button */}
        {!selectedFile && (
          <button
            type="button"
            disabled={uploading || inspectingFile}
            onClick={handleChooseApkClick}
            className="w-full py-8 px-4 rounded-2xl bg-[#0b101c] hover:bg-[#101829] border-2 border-dashed border-amber-400/50 hover:border-amber-400 text-amber-300 font-black text-sm flex flex-col items-center justify-center gap-2.5 transition cursor-pointer disabled:opacity-50 group"
          >
            <div className="w-12 h-12 rounded-full bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-2xl group-hover:scale-110 transition">
              📎
            </div>
            <span className="text-base font-black">إرفاق ملف APK</span>
            <span className="text-xs text-slate-400 font-normal">
              انقر لفتح مستعرض الملفات في هاتفك أو جهازك لاختيار ملف الـ APK
            </span>
          </button>
        )}

        {/* Inspecting Spinner */}
        {inspectingFile && (
          <div className="bg-[#0b0f17] border border-amber-400/30 rounded-xl p-4 text-xs text-amber-300 font-bold text-center flex items-center justify-center gap-2">
            <span className="animate-spin text-lg">⏳</span>
            <span>جارٍ فحص ملف الـ APK واستخراج بيانات الإصدار والتوقيع ورمز البناء...</span>
          </div>
        )}

        {/* Local Error Banner */}
        {localError && !inspection && (
          <div className="bg-rose-500/10 border border-rose-500/40 rounded-xl p-3.5 text-xs text-rose-300 font-bold">
            {localError}
          </div>
        )}

        {/* State B: File Attached -> Chat-style Attachment Card */}
        {selectedFile && (
          <div className="space-y-4">
            <div className="bg-[#0b101c] border border-amber-400/50 rounded-2xl p-4 sm:p-5 space-y-3.5 shadow-lg">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/40 flex items-center justify-center text-xl shrink-0">
                    📦
                  </div>
                  <div className="min-w-0">
                    <div dir="ltr" className="font-bold text-slate-100 text-sm truncate max-w-xs sm:max-w-md">
                      {selectedFile.name}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      الحجم: {formatBytesAr(selectedFile.size)} ({selectedFile.size.toLocaleString()} بايت)
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] font-black px-2.5 py-1 rounded-lg border ${
                      inspection?.canPublish
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : inspectingFile
                          ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                          : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                    }`}
                  >
                    {inspection?.canPublish
                      ? 'جاهز ومطابق للنشر ✓'
                      : inspectingFile
                        ? 'جارٍ الفحص...'
                        : 'غير مؤهل للنشر ✗'}
                  </span>

                  {!uploading && (
                    <button
                      type="button"
                      onClick={handleClearSelectedFile}
                      className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition cursor-pointer"
                    >
                      تغيير الملف ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Extracted Specs Grid */}
              {inspection && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                  <div className="bg-[#080c14] p-2.5 rounded-xl border border-slate-800">
                    <span className="block text-[10px] text-slate-400">معرّف التطبيق:</span>
                    <span
                      dir="ltr"
                      className={`block font-bold font-['JetBrains_Mono',monospace] text-[11px] mt-0.5 truncate ${
                        inspection.applicationIdMatchesSami ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {inspection.applicationId || 'غير معروف'}
                    </span>
                  </div>

                  <div className="bg-[#080c14] p-2.5 rounded-xl border border-slate-800">
                    <span className="block text-[10px] text-slate-400">اسم الإصدار (versionName):</span>
                    <span dir="ltr" className="block font-black text-amber-300 text-xs mt-0.5">
                      v{inspection.versionName || '?'}
                    </span>
                  </div>

                  <div className="bg-[#080c14] p-2.5 rounded-xl border border-slate-800">
                    <span className="block text-[10px] text-slate-400">كود البناء (versionCode):</span>
                    <span
                      dir="ltr"
                      className={`block font-black font-['JetBrains_Mono',monospace] text-xs mt-0.5 ${
                        inspection.isHigherThanPublished ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      Build {inspection.versionCode}
                    </span>
                  </div>

                  <div className="bg-[#080c14] p-2.5 rounded-xl border border-slate-800">
                    <span className="block text-[10px] text-slate-400">شهادة التوقيع:</span>
                    <span
                      className={`block font-bold text-[11px] mt-0.5 truncate ${
                        inspection.signatureMatchesOriginal ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {inspection.signatureMatchesOriginal ? 'مطابقة لـ Sami ✓' : 'غير مطابقة ✗'}
                    </span>
                  </div>
                </div>
              )}

              {/* Inspection Errors List */}
              {inspection && inspection.errors?.length > 0 && (
                <div className="bg-rose-500/15 border border-rose-500/40 rounded-xl p-3 space-y-1 text-rose-200 text-xs">
                  {inspection.errors.map((errStr, i) => (
                    <div key={i} className="font-bold">
                      • {errStr}
                    </div>
                  ))}
                </div>
              )}

              {/* Version Code Comparison Warning if <= current published */}
              {inspection && !inspection.isHigherThanPublished && (
                <div className="bg-amber-500/15 border border-amber-500/40 rounded-xl p-3 text-amber-200 text-xs font-bold leading-relaxed">
                  ⚠️ كود بناء ملف الـ APK المرفق (Build {inspection.versionCode}) يجب أن يكون أكبر من الإصدار المنشور
                  حالياً (Build {inspection.publishedVersionCode}) حتى يتعرف تطبيق المستخدمين عليه كتحديث أحدث.
                </div>
              )}
            </div>

            {/* Release Description & Mandatory Toggle */}
            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-bold mb-1.5">نوع التحديث للمستخدمين:</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => setIsMandatory(false)}
                    className={`p-3 rounded-xl border text-right transition cursor-pointer ${
                      !isMandatory
                        ? 'bg-amber-400/15 border-amber-400 text-amber-200 font-black'
                        : 'bg-[#0b0f17] border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs">تحديث اختياري مع إمكانية اختيار «لاحقًا»</div>
                    <div className="text-[10px] opacity-80 mt-0.5">يسمح للمستخدم بتأجيل التحديث ومتابعة التصفح</div>
                  </button>

                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => setIsMandatory(true)}
                    className={`p-3 rounded-xl border text-right transition cursor-pointer ${
                      isMandatory
                        ? 'bg-rose-500/15 border-rose-500 text-rose-200 font-black'
                        : 'bg-[#0b0f17] border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs">تحديث إلزامي</div>
                    <div className="text-[10px] opacity-80 mt-0.5">يلزم المستخدم بتحميل وتثبيت التحديث قبل المتابعة</div>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-bold mb-1.5">
                  ما الجديد في هذا التحديث (Release Notes):
                </label>
                <textarea
                  rows={3}
                  disabled={uploading}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="اكتب أبرز التحسينات والميزات في هذا الإصدار لتعرض للمستخدمين في نافذة التحديث..."
                  className="w-full bg-[#0b0f17] border border-slate-700 rounded-xl p-3 text-slate-100 text-xs focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            {/* LIVE RESILIENT UPLOAD & PROGRESS CARD */}
            {(uploading || uploadPaused || uploadError || uploadSuccessInfo) && (
              <div className="bg-[#0b0f19] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-black ${
                      uploadError
                        ? 'text-rose-400'
                        : uploadSuccessInfo
                          ? 'text-emerald-400'
                          : uploadPaused
                            ? 'text-amber-400'
                            : 'text-amber-300'
                    }`}
                  >
                    {uploadPhaseText}
                  </span>
                  <span dir="ltr" className="font-black text-slate-100 font-['JetBrains_Mono',monospace] tabular-nums">
                    {uploadPercent}%
                  </span>
                </div>

                <GoldProgressBar
                  percent={uploadPercent}
                  variant={uploadError ? 'rose' : uploadSuccessInfo ? 'emerald' : 'gold'}
                />

                <div className="flex items-center justify-between text-[11px] text-slate-400 font-['JetBrains_Mono',monospace] tabular-nums">
                  <span dir="ltr">
                    {formatBytesAr(uploadedBytes)} / {formatBytesAr(uploadTotalBytes)}
                  </span>
                  <span dir="ltr" className="text-amber-300 font-bold">
                    {uploading && uploadSpeedBps > 0 ? formatSpeedAr(uploadSpeedBps) : ''}
                  </span>
                </div>

                {/* Offline Warning Banner */}
                {isOffline && (
                  <div className="bg-amber-500/15 border border-amber-500/40 rounded-xl p-3 text-amber-200 text-xs font-bold leading-relaxed">
                    ⚠️ انقطع الاتصال بالإنترنت أثناء الرفع. تم الاحتفاظ بالملف المرفق ونقطة التقدم محلياً، وسنستأنف
                    الرفع تلقائياً فور عودة الشبكة.
                  </div>
                )}

                {/* Upload Error Banner with Retry Advice */}
                {uploadError && (
                  <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-rose-300 font-bold leading-relaxed">
                    {uploadError}
                  </div>
                )}

                {/* Success Banner */}
                {uploadSuccessInfo?.update && (
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3.5 text-emerald-200 space-y-1 text-xs">
                    <div className="font-black">
                      ✓ تم نشر التحديث v{uploadSuccessInfo.update.versionName} بنجاح وحفظ الحزمة في Firebase Storage
                      والسجل في Cloud Firestore!
                    </div>
                  </div>
                )}

                {/* Upload Controls: Pause, Resume, Retry, Cancel */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-800">
                  {uploading && (
                    <button
                      type="button"
                      onClick={handlePauseUpload}
                      className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 font-bold text-xs cursor-pointer"
                    >
                      ⏸️ إيقاف مؤقت
                    </button>
                  )}

                  {uploadPaused && (
                    <button
                      type="button"
                      onClick={handleResumeUpload}
                      className="px-3.5 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs cursor-pointer"
                    >
                      ▶️ استئناف الرفع
                    </button>
                  )}

                  {uploadError && (
                    <button
                      type="button"
                      onClick={() => handleStartFirebaseUpload(true)}
                      className="px-3.5 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs cursor-pointer"
                    >
                      🔄 إعادة المحاولة
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleCancelUpload}
                    className="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold cursor-pointer"
                  >
                    ✕ إلغاء
                  </button>
                </div>
              </div>
            )}

            {/* Publish Button */}
            {!uploading && !uploadSuccessInfo && (
              <button
                type="button"
                disabled={inspectingFile || !selectedFile || !inspection?.canPublish}
                onClick={() => handleStartFirebaseUpload(false)}
                className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 disabled:opacity-40 text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition cursor-pointer"
              >
                <span>🚀 نشر التحديث عبر Firebase</span>
              </button>
            )}
          </div>
        )}

        {/* Global Preview Modal Button */}
        <div className="pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={() => setShowPreviewModal(true)}
            className="w-full py-2.5 rounded-xl bg-[#0b0f17] hover:bg-slate-800 text-amber-300 font-bold text-xs border border-amber-400/30 transition cursor-pointer"
          >
            معاينة تصميم نافذة التحديث للمستخدم
          </button>
        </div>
      </div>

      {/* 3. RELEASE HISTORY & VERSION CONTROLS */}
      <div className="bg-[#121824] border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-black text-amber-400">
              سجل الإصدارات المنشورة في Firebase
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              كل إصدار مخزن في Firebase Storage ومسجل في Cloud Firestore مع إمكانية إيقاف توزيعه أو الرجوع إليه
            </p>
          </div>
          <span className="text-[11px] text-slate-400 font-['JetBrains_Mono',monospace] tabular-nums">
            {historyList.length} إصدار
          </span>
        </div>

        {historyList.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">لا توجد سجلات إصدارات منشورة بعد.</p>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {historyList.map((item) => {
              const isItemActive = item.isActive !== false && item.distributionStatus !== 'disabled';
              const targetId = item.id || item.updateId || item.versionCode;
              const isTogglingThis = togglingUpdateId === targetId;

              return (
                <div
                  key={`${item.versionCode}_${item.id || item.updateId || ''}`}
                  className={`bg-[#0b0f17] border rounded-xl p-3.5 space-y-2.5 text-xs transition ${
                    isItemActive ? 'border-slate-700/80' : 'border-slate-800 opacity-80'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        dir="ltr"
                        className="font-black text-slate-100 font-['JetBrains_Mono',monospace] tabular-nums text-sm"
                      >
                        v{item.versionName}
                      </span>
                      <span className="text-[10px] text-slate-400 font-['JetBrains_Mono',monospace] tabular-nums">
                        Build {item.versionCode}
                      </span>

                      {/* Storage Source Badge */}
                      <span className="text-[10px] font-black px-2 py-0.5 rounded border bg-amber-500/15 border-amber-500/40 text-amber-300">
                        ⚡ Firebase Storage
                      </span>

                      {/* Status Badge */}
                      <span
                        className={`text-[10px] font-black px-2 py-0.5 rounded border ${
                          isItemActive
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                        }`}
                      >
                        {isItemActive ? 'مفعّل للتوزيع ✓' : 'معطّل للتوزيع ⏸️'}
                      </span>

                      {/* Mandatory / Optional Badge */}
                      <span className="text-[10px] text-slate-400 font-bold">
                        {item.isMandatory ? 'إلزامي' : 'اختياري'}
                      </span>

                      {item.fileSize && (
                        <span className="text-[10px] text-slate-500 font-['JetBrains_Mono',monospace]">
                          {formatBytesAr(item.fileSize)}
                        </span>
                      )}
                    </div>

                    {item.publishedAt && (
                      <span className="text-[10px] text-slate-500">
                        {new Date(item.publishedAt).toLocaleDateString('ar-EG', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    )}
                  </div>

                  {/* Title and Notes */}
                  {item.description && (
                    <p className="text-slate-300 text-[11px] leading-relaxed">{item.description}</p>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                    <button
                      type="button"
                      disabled={isTogglingThis}
                      onClick={() => handleToggleIndividualUpdate(item)}
                      className={`px-3 py-1.5 rounded-lg font-black text-[11px] border transition cursor-pointer disabled:opacity-50 ${
                        isItemActive
                          ? 'bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/40 text-rose-300'
                          : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                      }`}
                    >
                      {isTogglingThis
                        ? 'جارٍ التحديث...'
                        : isItemActive
                          ? '⏸️ إيقاف توزيع هذا التحديث'
                          : '▶️ تفعيل توزيع هذا التحديث'}
                    </button>

                    {!isItemActive && (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => handleRollbackToVersion(item.versionCode)}
                        className="px-3 py-1.5 rounded-lg bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/40 text-amber-300 font-black text-[11px] transition cursor-pointer disabled:opacity-50"
                      >
                        اعتماد هذا الإصدار
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal Preview */}
      {showPreviewModal && (
        <SamiUserUpdateModal
          isOpen={showPreviewModal}
          isPreview={true}
          onDismiss={() => setShowPreviewModal(false)}
          config={
            inspection
              ? {
                  versionName: inspection.versionName || '1.3.2',
                  versionCode: inspection.versionCode || effectiveMinVersionCode + 1,
                  description: description.trim() || 'تحديث تجريبي للمعاينة داخل لوحة الإدارة',
                  fileSize: inspection.fileSize,
                  sha256: inspection.sha256,
                  signingCertSha256: inspection.signingCertificate?.sha256Fingerprint,
                  applicationId: inspection.applicationId,
                  storageSource: 'firebase_storage',
                  downloadUrl: '',
                  isMandatory,
                  isActive: true,
                  isHidden: false,
                }
              : currentPublished
                ? currentPublished
                : {
                    versionName: '1.3.2',
                    versionCode: effectiveMinVersionCode + 1,
                    description:
                      description.trim() ||
                      'تحسينات شاملة في الأداء وتثبيت التحديثات المباشر من داخل تطبيق Sami عبر Firebase.',
                    fileSize: 28 * 1024 * 1024,
                    storageSource: 'firebase_storage',
                    downloadUrl: '',
                    isMandatory,
                    isActive: true,
                    isHidden: false,
                  }
          }
        />
      )}
    </div>
  );
}
