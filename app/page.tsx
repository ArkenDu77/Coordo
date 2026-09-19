'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Heart, FileText, Upload, Mic, Play, Check, X, Loader2, Download, AlertCircle, Clock, RotateCcw, Sparkles } from 'lucide-react';
import { CourseUpdateJob, Suggestion } from '@/lib/db';

export default function Home() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<CourseUpdateJob | null>(null);
  const [localUploadProgress, setLocalUploadProgress] = useState<{ percent: number; message: string } | null>(null);

  // Reprise automatique si un job actif existe dans le stockage local
  useEffect(() => {
    const savedJobId = localStorage.getItem('co-ordo-active-job-id');
    if (savedJobId && !jobId) {
      fetch(`/api/jobs/${savedJobId}`)
        .then(async (res) => {
          if (res.ok) {
            const data: CourseUpdateJob = await res.json();
            if (data && data.status) {
              setJobId(savedJobId);
              setJob(data);
            } else {
              localStorage.removeItem('co-ordo-active-job-id');
            }
          } else {
            localStorage.removeItem('co-ordo-active-job-id');
          }
        })
        .catch(() => {});
    }
  }, [jobId]);

  // Synchronisation de l'identifiant du job actif
  useEffect(() => {
    if (jobId) {
      localStorage.setItem('co-ordo-active-job-id', jobId);
    }
  }, [jobId]);

  // Polling pendant le traitement actif
  useEffect(() => {
    if (!jobId) return;

    let interval: NodeJS.Timeout;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (res.ok) {
          const data: CourseUpdateJob = await res.json();
          setJob(data);
          if (data.status === 'review' || data.status === 'completed' || data.status === 'failed') {
            clearInterval(interval);
          }
        }
      } catch (err) {
        console.error('Erreur lors du suivi du job:', err);
      }
    };

    // Polling plus réactif (1 seconde) pour une barre de progression fluide
    interval = setInterval(fetchStatus, 1000);
    fetchStatus();

    return () => clearInterval(interval);
  }, [jobId]);

  function handleRetry() {
    setJobId(null);
    setJob(null);
    setLocalUploadProgress(null);
    localStorage.removeItem('co-ordo-active-job-id');
    localStorage.removeItem('co-ordo-upload-session');
  }

  return (
    <div className="min-h-screen bg-pink-50 text-pink-950 font-sans selection:bg-pink-200">
      <header className="max-w-4xl mx-auto pt-12 pb-6 px-6 text-center">
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="inline-flex items-center gap-2 mb-2">
          <Heart className="w-8 h-8 text-pink-500 fill-pink-500" />
          <h1 className="text-4xl font-extrabold tracking-tight text-pink-600">Co-Ordo</h1>
          <Heart className="w-8 h-8 text-pink-500 fill-pink-500" />
        </motion.div>
        <p className="text-lg text-pink-700/80 mb-2">Actualisez vos fiches de cours automatiquement</p>
        <p className="text-sm font-medium text-pink-400">je t&apos;aime Noa 💖</p>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        <AnimatePresence mode="wait">
          {!jobId && (
            <UploadView
              key="upload"
              onJobCreated={(newJobId, initialJob) => {
                setJobId(newJobId);
                setJob(initialJob);
              }}
              onUploadProgress={(percent, message) => {
                setLocalUploadProgress({ percent, message });
              }}
              onUploadFinished={() => {
                setLocalUploadProgress(null);
              }}
              onUploadFailed={(errMsg) => {
                setJob((prev) => (prev ? { ...prev, status: 'failed', error: errMsg } : null));
                setLocalUploadProgress(null);
              }}
            />
          )}

          {jobId && (job?.status === 'processing' || job?.status === 'uploading' || job?.status === 'pending') && (
            <ProcessingView
              key="processing"
              job={job}
              localUploadProgress={localUploadProgress}
            />
          )}

          {jobId && job?.status === 'review' && (
            <ReviewView key="review" job={job} setJob={setJob} />
          )}

          {jobId && job?.status === 'completed' && (
            <CompletedView key="completed" jobId={jobId} onNewUpload={handleRetry} />
          )}
          
          {jobId && job?.status === 'failed' && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="p-10 bg-white rounded-[2rem] shadow-sm border border-red-100 text-center max-w-xl mx-auto"
            >
              <div className="w-20 h-20 mx-auto mb-6 bg-red-50 text-red-500 rounded-full flex items-center justify-center border border-red-100">
                <AlertCircle className="w-10 h-10" />
              </div>
              <h2 className="text-2xl font-bold text-red-950 mb-3">
                {job.error || "L’analyse n’a pas pu être terminée."}
              </h2>
              <p className="text-red-700/80 mb-8 leading-relaxed">
                {job.error?.includes('trop de temps')
                  ? "Veuillez réessayer."
                  : "Réessayez dans quelques instants. Si le problème persiste, vérifiez vos fichiers ou votre connexion."}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-pink-500/25 transition-all hover:shadow-pink-500/40 active:scale-[0.98]"
              >
                <RotateCcw className="w-5 h-5" />
                Réessayer
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

interface SelectedFile {
  blob: Blob;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 o';
  const k = 1024;
  const sizes = ['o', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function isValidDocument(file: File): boolean {
  const name = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  const validExtensions = [
    '.docx',
    '.pdf',
    '.odt',
    '.rtf',
    '.txt',
    '.html',
    '.htm',
    '.doc',
    '.jpg',
    '.jpeg',
    '.png',
    '.heic',
    '.heif',
    '.webp',
  ];
  if (validExtensions.some((ext) => name.endsWith(ext))) return true;
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/pdf' ||
    mime === 'application/vnd.oasis.opendocument.text' ||
    mime === 'application/rtf' ||
    mime === 'text/rtf' ||
    mime === 'text/plain' ||
    mime === 'text/html' ||
    mime === 'application/msword' ||
    mime.startsWith('image/')
  ) {
    return true;
  }
  return false;
}

function isValidAudio(file: File): boolean {
  if (file.type && file.type.startsWith('audio/')) return true;
  if (file.type === 'video/webm' || file.type === 'video/ogg') return true;
  const name = file.name.toLowerCase();
  const validExtensions = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.webm', '.opus', '.wma', '.caf', '.aiff', '.alac'];
  return validExtensions.some(ext => name.endsWith(ext));
}

function extractFilesFromDragEvent(e: React.DragEvent): File[] {
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    return Array.from(e.dataTransfer.files);
  }
  if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
    const files: File[] = [];
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    return files;
  }
  return [];
}

function UploadView({ 
  onJobCreated,
  onUploadProgress,
  onUploadFinished,
  onUploadFailed,
}: { 
  onJobCreated: (id: string, initialJob: CourseUpdateJob) => void;
  onUploadProgress: (percent: number, message: string) => void;
  onUploadFinished: () => void;
  onUploadFailed: (errMsg: string) => void;
}) {
  const [docxData, setDocxData] = useState<SelectedFile | null>(null);
  const [audioData, setAudioData] = useState<SelectedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDraggingDocx, setIsDraggingDocx] = useState(false);
  const [isDraggingAudio, setIsDraggingAudio] = useState(false);

  const docxDragCounter = useRef(0);
  const audioDragCounter = useRef(0);

  function handleDocxSelection(file: File) {
    if (!isValidDocument(file)) {
      alert("Veuillez sélectionner un document valide (.docx, .pdf, .odt, .rtf, .txt, .html, .doc ou image scannée).");
      return;
    }
    setDocxData({
      blob: file,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    });
  }

  function handleAudioSelection(file: File) {
    if (!isValidAudio(file)) {
      alert("Veuillez sélectionner un fichier audio valide (MP3, M4A, WAV, AAC, etc.).");
      return;
    }
    setAudioData({
      blob: file,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    });
  }

  const onDocxDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    docxDragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingDocx(true);
    }
  };

  const onDocxDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDraggingDocx) setIsDraggingDocx(true);
  };

  const onDocxDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    docxDragCounter.current -= 1;
    if (docxDragCounter.current <= 0) {
      docxDragCounter.current = 0;
      setIsDraggingDocx(false);
    }
  };

  const onDocxDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    docxDragCounter.current = 0;
    setIsDraggingDocx(false);
    const files = extractFilesFromDragEvent(e);
    if (files.length > 0) {
      handleDocxSelection(files[0]);
    }
  };

  const onAudioDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    audioDragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingAudio(true);
    }
  };

  const onAudioDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDraggingAudio) setIsDraggingAudio(true);
  };

  const onAudioDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    audioDragCounter.current -= 1;
    if (audioDragCounter.current <= 0) {
      audioDragCounter.current = 0;
      setIsDraggingAudio(false);
    }
  };

  const onAudioDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    audioDragCounter.current = 0;
    setIsDraggingAudio(false);
    const files = extractFilesFromDragEvent(e);
    if (files.length > 0) {
      handleAudioSelection(files[0]);
    }
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!docxData || !audioData) {
      alert("Veuillez sélectionner à la fois la fiche de cours et l'enregistrement audio.");
      return;
    }

    setLoading(true);
    const formData = new FormData(e.currentTarget);
    const subject = (formData.get('subject') as string) || 'Autre';
    const courseName = (formData.get('courseName') as string) || 'Nouveau cours';

    try {
      const chunkSize = 5 * 1024 * 1024; // 5 Mo par chunk
      let offset = 0;
      let uploadJobId: string | null = null;

      // 1. Initialisation côté serveur
      onUploadProgress(2, 'Initialisation du transfert et préparation de la fiche...');

      const initData = new FormData();
      initData.append('doc', docxData.blob, docxData.name);
      initData.append('docx', docxData.blob, docxData.name);
      initData.append('subject', subject);
      initData.append('courseName', courseName);
      initData.append('audioName', audioData.name);
      initData.append('audioSize', audioData.size.toString());
      initData.append('audioMimeType', audioData.type || 'audio/mp3');

      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        body: initData,
      });

      if (!initRes.ok) {
        throw new Error("L’analyse n’a pas pu être terminée. Réessayez dans quelques instants.");
      }
      const initResult = await initRes.json();
      uploadJobId = initResult.jobId;

      // Création du squelette du job pour transitionner immédiatement vers ProcessingView
      const initialJob: CourseUpdateJob = {
        id: uploadJobId!,
        createdAt: new Date().toISOString(),
        status: 'uploading',
        subject,
        courseName,
        originalDocxPath: '',
        audioPath: '',
        audioSizeBytes: audioData.size,
        documentSizeBytes: docxData.size,
        progress: {
          percent: 5,
          stage: 'upload',
          stageLabel: 'Envoi de l’audio',
          message: 'Envoi de l’audio en cours...',
          stepDescription: 'Envoi de l’audio',
          etaFormatted: 'Temps restant estimé : quelques minutes',
        },
        suggestions: [],
      };

      // Basculer l'écran vers ProcessingView immédiatement
      onJobCreated(uploadJobId!, initialJob);
      onUploadProgress(5, 'Envoi de l’audio...');

      // 2. Envoi par morceaux de l'audio (0–20 % de la progression globale)
      while (offset < audioData.size) {
        const chunk = audioData.blob.slice(offset, offset + chunkSize);
        const isLast = offset + chunk.size >= audioData.size;

        let attempts = 0;
        let success = false;
        
        while (!success && attempts < 3) {
          try {
            const chunkRes = await fetch('/api/upload/chunk', {
              method: 'POST',
              headers: {
                'x-job-id': uploadJobId!,
                'x-offset': offset.toString(),
                'x-is-last': isLast.toString(),
                'Content-Type': 'application/octet-stream',
              },
              body: chunk,
            });
            if (chunkRes.ok) {
              success = true;
            } else {
              throw new Error("Erreur serveur lors du chunk");
            }
          } catch (err) {
            attempts++;
            await new Promise(r => setTimeout(r, 1500));
          }
        }

        if (!success) {
          throw new Error("Échec de l’envoi après plusieurs tentatives");
        }

        offset += chunk.size;
        const uploadFraction = Math.min(1, offset / audioData.size);
        const stagePercent = Math.min(20, Math.round(5 + uploadFraction * 15));
        onUploadProgress(
          stagePercent,
          isLast ? 'Envoi terminé, préparation de la fiche...' : `Envoi de l’audio (${Math.round(uploadFraction * 100)}%)...`
        );
      }

      onUploadFinished();

      // 3. Déclencher le traitement serveur (attente réelle de la fin du traitement)
      const processRes = await fetch(`/api/jobs/${uploadJobId}/process`, { method: 'POST' });
      if (!processRes.ok) {
        const errJson = await processRes.json().catch(() => ({}));
        const userMsg = errJson?.error || "L’analyse n’a pas pu être terminée. Réessayez dans quelques instants.";
        onUploadFailed(userMsg);
      }
    } catch (err: any) {
      console.error('[Upload Pipeline Error]', err);
      const errMsg = err?.message?.includes('trop de temps')
        ? "L’analyse a pris trop de temps. Veuillez réessayer."
        : (err?.message || "L’analyse n’a pas pu être terminée. Réessayez dans quelques instants.");
      onUploadFailed(errMsg);
      setLoading(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
      <form onSubmit={onSubmit} className="bg-white p-8 md:p-10 rounded-[2rem] shadow-sm border border-pink-100 flex flex-col gap-8 relative overflow-hidden">
        {loading && (
          <div className="absolute inset-0 bg-white/70 backdrop-blur-xs z-10 flex flex-col items-center justify-center">
            <Loader2 className="w-10 h-10 text-pink-500 animate-spin mb-3" />
            <p className="text-pink-700 font-semibold">Démarrage de l’actualisation...</p>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          {/* ZONE 1 : DOCUMENT */}
          <label 
            onDragEnter={onDocxDragEnter}
            onDragOver={onDocxDragOver}
            onDragLeave={onDocxDragLeave}
            onDrop={onDocxDrop}
            className={`relative flex flex-col items-center justify-center p-10 border-2 border-dashed rounded-3xl cursor-pointer transition-all duration-200 group text-center ${
              isDraggingDocx
                ? 'border-pink-500 bg-pink-100/70 scale-[1.02] shadow-md ring-4 ring-pink-200'
                : docxData
                ? 'border-pink-300 bg-pink-50/40 hover:bg-pink-50/70 hover:border-pink-400'
                : 'border-pink-200 hover:bg-pink-50/50 hover:border-pink-300'
            }`}
          >
            {isDraggingDocx ? (
              <div className="flex flex-col items-center justify-center py-2 pointer-events-none">
                <Upload className="w-12 h-12 text-pink-600 mb-3 animate-bounce" />
                <span className="font-bold text-pink-700 text-base">Déposez votre fiche ici</span>
                <span className="text-xs text-pink-500 mt-1 font-medium">Glisser-déposer iPad / Fichiers</span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center pointer-events-none w-full">
                <FileText className={`w-10 h-10 mb-3 transition-colors ${docxData ? 'text-pink-500' : 'text-pink-300 group-hover:text-pink-400'}`} />
                <span className="font-semibold text-pink-700">Fiche de l&apos;année précédente</span>
                {docxData ? (
                  <div className="flex flex-col items-center gap-1 my-3 bg-white/90 border border-pink-200 py-2 px-4 rounded-2xl max-w-full shadow-xs">
                    <span className="font-semibold text-pink-900 text-sm max-w-[220px] truncate" title={docxData.name}>
                      {docxData.name}
                    </span>
                    <span className="text-xs text-pink-500 font-medium">{formatFileSize(docxData.size)}</span>
                  </div>
                ) : (
                  <span className="text-sm text-pink-400 mb-4">DOCX, PDF, ODT, RTF, TXT, HTML, DOC ou photos</span>
                )}
                <span className="bg-pink-100 text-pink-700 px-4 py-2 rounded-full text-sm font-medium group-hover:bg-pink-200 transition-colors pointer-events-auto">
                  {docxData ? 'Changer le fichier' : 'Choisir le fichier'}
                </span>
              </div>
            )}
            <input 
              type="file" 
              name="doc" 
              accept=".docx,.pdf,.odt,.rtf,.txt,.html,.htm,.doc,.jpg,.jpeg,.png,.heic,.heif,.webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,application/vnd.oasis.opendocument.text,application/rtf,text/plain,text/html,application/msword,image/*" 
              className="hidden" 
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleDocxSelection(e.target.files[0]);
                }
              }}
              onClick={(e) => {
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>

          {/* ZONE 2 : AUDIO */}
          <label 
            onDragEnter={onAudioDragEnter}
            onDragOver={onAudioDragOver}
            onDragLeave={onAudioDragLeave}
            onDrop={onAudioDrop}
            className={`relative flex flex-col items-center justify-center p-10 border-2 border-dashed rounded-3xl cursor-pointer transition-all duration-200 group text-center ${
              isDraggingAudio
                ? 'border-pink-500 bg-pink-100/70 scale-[1.02] shadow-md ring-4 ring-pink-200'
                : audioData
                ? 'border-pink-300 bg-pink-50/40 hover:bg-pink-50/70 hover:border-pink-400'
                : 'border-pink-200 hover:bg-pink-50/50 hover:border-pink-300'
            }`}
          >
            {isDraggingAudio ? (
              <div className="flex flex-col items-center justify-center py-2 pointer-events-none">
                <Mic className="w-12 h-12 text-pink-600 mb-3 animate-bounce" />
                <span className="font-bold text-pink-700 text-base">Déposez votre enregistrement audio</span>
                <span className="text-xs text-pink-500 mt-1 font-medium">Glisser-déposer iPad / Dictaphone</span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center pointer-events-none w-full">
                <Mic className={`w-10 h-10 mb-3 transition-colors ${audioData ? 'text-pink-500' : 'text-pink-300 group-hover:text-pink-400'}`} />
                <span className="font-semibold text-pink-700">Enregistrement du nouveau cours</span>
                {audioData ? (
                  <div className="flex flex-col items-center gap-1 my-3 bg-white/90 border border-pink-200 py-2 px-4 rounded-2xl max-w-full shadow-xs">
                    <span className="font-semibold text-pink-900 text-sm max-w-[220px] truncate" title={audioData.name}>
                      {audioData.name}
                    </span>
                    <span className="text-xs text-pink-500 font-medium">{formatFileSize(audioData.size)}</span>
                  </div>
                ) : (
                  <span className="text-sm text-pink-400 mb-4">MP3, M4A, WAV, AAC, FLAC</span>
                )}
                <span className="bg-pink-100 text-pink-700 px-4 py-2 rounded-full text-sm font-medium group-hover:bg-pink-200 transition-colors pointer-events-auto">
                  {audioData ? 'Changer le fichier' : 'Choisir le fichier'}
                </span>
              </div>
            )}
            <input 
              type="file" 
              name="audio" 
              accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.webm" 
              className="hidden" 
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleAudioSelection(e.target.files[0]);
                }
              }}
              onClick={(e) => {
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>
        </div>

        <div className="flex flex-col md:flex-row gap-6">
          <div className="flex-1">
            <label className="block text-sm font-semibold text-pink-800 mb-2">Matière</label>
            <select name="subject" className="w-full p-4 rounded-2xl bg-pink-50 border border-pink-100 focus:outline-none focus:ring-2 focus:ring-pink-300 text-pink-900 font-medium">
              <option>Psychologie</option>
              <option>SSS / Santé publique</option>
              <option>Odontologie</option>
              <option>Anatomie</option>
              <option>Biologie cellulaire</option>
              <option>Autre</option>
            </select>
          </div>
          <div className="flex-[2]">
            <label className="block text-sm font-semibold text-pink-800 mb-2">Nom du cours</label>
            <input type="text" name="courseName" required placeholder="Ex: Déterminants de santé" className="w-full p-4 rounded-2xl bg-pink-50 border border-pink-100 focus:outline-none focus:ring-2 focus:ring-pink-300 text-pink-900 placeholder:text-pink-300 font-medium" />
          </div>
        </div>

        <button type="submit" disabled={loading} className="w-full bg-pink-500 hover:bg-pink-600 text-white font-bold text-lg py-5 rounded-2xl shadow-lg shadow-pink-500/20 transition-all hover:shadow-pink-500/40 active:scale-[0.98] disabled:opacity-50">
          ANALYSER ET ACTUALISER LA FICHE
        </button>
      </form>
    </motion.div>
  );
}

const STAGES_CONFIG = [
  { key: 'upload', label: 'Envoi de l’audio', range: '0–20 %', min: 0, max: 20 },
  { key: 'doc_prep', label: 'Préparation de la fiche', range: '20–30 %', min: 20, max: 30 },
  { key: 'course_analysis', label: 'Analyse du cours', range: '30–80 %', min: 30, max: 80 },
  { key: 'verification', label: 'Vérification des actualisations', range: '80–95 %', min: 80, max: 95 },
  { key: 'finalizing', label: 'Préparation de la fiche', range: '95–100 %', min: 95, max: 100 },
];

function ProcessingView({
  job,
  localUploadProgress
}: {
  job: CourseUpdateJob;
  localUploadProgress?: { percent: number; message: string } | null;
}) {
  const currentPercent = localUploadProgress ? localUploadProgress.percent : (job.progress?.percent || 0);
  const isCompleted = currentPercent >= 100;
  
  // Étape actuelle
  const currentStageLabel = localUploadProgress
    ? 'Envoi de l’audio'
    : (job.progress?.stageLabel || (currentPercent <= 20 ? 'Envoi de l’audio' : 'Analyse du cours'));
    
  const currentDescription = localUploadProgress
    ? localUploadProgress.message
    : (job.progress?.stepDescription || job.progress?.message || 'Traitement en cours...');

  const etaText = isCompleted
    ? 'Actualisation terminée'
    : (job.progress?.etaFormatted || 'Temps restant estimé : quelques minutes');

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="bg-white p-8 md:p-12 rounded-[2.5rem] shadow-sm border border-pink-100 max-w-2xl mx-auto text-left"
    >
      {/* En-tête principal de la progression */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-pink-500 bg-pink-50 px-3 py-1 rounded-full">
            {job.subject} • {job.courseName}
          </span>
          <h2 className="text-2xl md:text-3xl font-extrabold text-pink-900 mt-2">
            {isCompleted ? 'Actualisation terminée' : 'Analyse du cours en cours'}
          </h2>
        </div>
        <div className="text-right shrink-0">
          <span className="text-3xl md:text-4xl font-extrabold text-pink-600 font-mono tracking-tight">
            {currentPercent} %
          </span>
        </div>
      </div>

      {/* LA GRANDE BARRE DE PROGRESSION (0 à 100%) */}
      <div className="space-y-3 mb-8">
        <div className="w-full bg-pink-100/80 rounded-full h-6 p-1 relative overflow-hidden shadow-inner">
          <motion.div 
            className="h-full bg-gradient-to-r from-pink-500 via-pink-600 to-rose-500 rounded-full shadow-sm relative overflow-hidden"
            style={{ width: `${Math.max(3, Math.min(100, currentPercent))}%` }}
            initial={{ width: '0%' }}
            animate={{ width: `${Math.max(3, Math.min(100, currentPercent))}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          >
            <div className="absolute inset-0 bg-white/25 rounded-full animate-pulse" />
          </motion.div>
        </div>

        {/* Ligne d'information détaillée sous la barre */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm pt-1">
          <div className="font-semibold text-pink-900 flex items-center gap-2 truncate">
            <span className="w-2 h-2 rounded-full bg-pink-500 animate-ping shrink-0" />
            <span className="truncate">{currentDescription}</span>
          </div>

          <div className="inline-flex items-center gap-1.5 text-pink-600 bg-pink-50 px-3 py-1 rounded-xl text-xs font-semibold shrink-0">
            <Clock className="w-3.5 h-3.5 text-pink-500 shrink-0" />
            <span>{etaText}</span>
          </div>
        </div>
      </div>

      {/* DÉTAIL DES 6 ÉTAPES */}
      <div className="bg-pink-50/50 rounded-2xl p-5 border border-pink-100/80 space-y-3.5 mb-8">
        <div className="text-xs font-bold uppercase tracking-wider text-pink-400 mb-2">
          Étapes de traitement
        </div>
        {STAGES_CONFIG.map((stage) => {
          const isDone = currentPercent >= stage.max;
          const isActive = currentPercent >= stage.min && currentPercent < stage.max;

          return (
            <div
              key={stage.key}
              className={`flex items-center justify-between text-sm transition-colors ${
                isDone
                  ? 'text-pink-800 font-medium'
                  : isActive
                  ? 'text-pink-950 font-bold'
                  : 'text-pink-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all ${
                    isDone
                      ? 'bg-pink-500 text-white shadow-xs'
                      : isActive
                      ? 'bg-pink-100 text-pink-600 ring-2 ring-pink-300 shadow-xs'
                      : 'bg-white border border-pink-200'
                  }`}
                >
                  {isDone ? (
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  ) : isActive ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-pink-600" />
                  ) : (
                    <div className="w-1.5 h-1.5 rounded-full bg-pink-200" />
                  )}
                </div>
                <span>{stage.label}</span>
              </div>

              <span className={`text-xs font-mono px-2 py-0.5 rounded-md ${
                isDone ? 'bg-pink-100/80 text-pink-600' : isActive ? 'bg-pink-200/70 text-pink-800 font-bold' : 'text-pink-300'
              }`}>
                {stage.range}
              </span>
            </div>
          );
        })}
      </div>

      {/* Note rassurante de persistance */}
      <p className="text-xs text-pink-500/90 text-center leading-relaxed">
        Le traitement s’exécute sur nos serveurs. Vous pouvez quitter cette page ou la recharger à tout moment : votre progression est conservée automatiquement.
      </p>
    </motion.div>
  );
}

function ReviewView({ job, setJob }: { job: CourseUpdateJob, setJob: any }) {
  const [submitting, setSubmitting] = useState(false);
  const [localJob, setLocalJob] = useState(job);

  const additions = localJob.suggestions.filter(s => s.type === 'ADD').length;
  const deletions = localJob.suggestions.filter(s => s.type === 'DELETE').length;
  const toVerify = localJob.suggestions.filter(s => s.type === 'VERIFY').length;
  
  function updateSuggestionStatus(id: string, status: 'accepted' | 'rejected') {
    setLocalJob(prev => ({
      ...prev,
      suggestions: prev.suggestions.map(s => s.id === id ? { ...s, status } : s)
    }));
  }

  async function handleExport() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: localJob.suggestions })
      });
      if (res.ok) {
        setJob({ ...localJob, status: 'completed' });
      } else {
        alert("Erreur lors de l'export.");
        setSubmitting(false);
      }
    } catch (err) {
      console.error(err);
      alert("Erreur réseau.");
      setSubmitting(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
      <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-pink-100 text-center">
        <h2 className="text-3xl font-extrabold text-pink-700 mb-4">Actualisation terminée</h2>
        <div className="flex flex-wrap justify-center gap-4 text-sm font-medium">
          <span className="bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full">{additions} ajouts proposés</span>
          <span className="bg-rose-50 text-rose-700 px-4 py-2 rounded-full">{deletions} suppressions proposées</span>
          <span className="bg-amber-50 text-amber-700 px-4 py-2 rounded-full">{toVerify} éléments à vérifier</span>
        </div>
      </div>

      {localJob.conversionWarning && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 p-4 rounded-2xl flex items-center gap-3 text-left shadow-xs">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
          <span className="text-sm font-semibold">{localJob.conversionWarning}</span>
        </div>
      )}

      <div className="space-y-6">
        {localJob.suggestions.map((suggestion) => (
          <SuggestionCard key={suggestion.id} suggestion={suggestion} onUpdate={(status) => updateSuggestionStatus(suggestion.id, status)} />
        ))}
      </div>

      <div className="sticky bottom-6 mt-12 bg-white/80 backdrop-blur-xl p-4 rounded-3xl shadow-xl shadow-pink-900/5 border border-pink-100 flex items-center justify-between">
        <p className="text-pink-600 font-medium px-4">
          {localJob.suggestions.filter(s => s.status === 'pending').length} modifications en attente
        </p>
        <button 
          onClick={handleExport}
          disabled={submitting}
          className="bg-pink-600 hover:bg-pink-700 text-white font-bold px-8 py-4 rounded-2xl transition-all shadow-lg shadow-pink-500/20 active:scale-95 disabled:opacity-50"
        >
          {submitting ? 'GÉNÉRATION...' : 'GÉNÉRER LA FICHE ACTUALISÉE'}
        </button>
      </div>
    </motion.div>
  );
}

function SuggestionCard({ suggestion, onUpdate }: { suggestion: Suggestion, onUpdate: (status: 'accepted' | 'rejected') => void }) {
  const isAdd = suggestion.type === 'ADD';
  const isVerify = suggestion.type === 'VERIFY';

  const colorCls = isAdd ? 'text-emerald-700 bg-emerald-50 border-emerald-100' : isVerify ? 'text-amber-700 bg-amber-50 border-amber-100' : 'text-rose-700 bg-rose-50 border-rose-100';
  const badgeCls = isAdd ? 'bg-emerald-100 text-emerald-800' : isVerify ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800';

  return (
    <div className={`p-6 rounded-[2rem] border ${colorCls} transition-all ${suggestion.status !== 'pending' ? 'opacity-50 grayscale' : ''}`}>
      <div className="flex justify-between items-start mb-4">
        <span className={`text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full ${badgeCls}`}>
          {isAdd ? 'Ajout Proposé' : isVerify ? 'À Vérifier' : 'Suppression Proposée'}
        </span>
        <div className="flex gap-2">
          {suggestion.status === 'pending' ? (
            <>
              <button onClick={() => onUpdate('rejected')} className="px-4 py-2 rounded-xl bg-white/50 hover:bg-white text-sm font-bold transition-colors">
                {isAdd ? 'REFUSER' : 'CONSERVER'}
              </button>
              <button onClick={() => onUpdate('accepted')} className="px-4 py-2 rounded-xl bg-white hover:shadow-sm text-sm font-bold transition-all shadow-sm">
                ACCEPTER
              </button>
            </>
          ) : (
            <span className="px-4 py-2 font-bold text-sm bg-white/50 rounded-xl">
              {suggestion.status === 'accepted' ? 'ACCEPTÉ' : 'REFUSÉ'}
            </span>
          )}
        </div>
      </div>

      <div className="mb-4 bg-white/60 p-4 rounded-2xl">
        <p className="text-xs font-bold uppercase tracking-wider mb-2 opacity-60">
          {isAdd ? 'Nouvelle information :' : 'Texte actuel :'}
        </p>
        <p className={`font-serif text-lg leading-relaxed ${!isAdd ? 'line-through opacity-70' : ''}`}>
          {isAdd ? suggestion.proposedText : suggestion.originalText}
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 text-sm">
        <div>
          <p className="font-bold opacity-70 mb-1">Motif :</p>
          <p>{suggestion.reason}</p>
          {isVerify && <p className="mt-2 text-amber-800 font-bold">⚠ Vérification requise.</p>}
        </div>
        <div>
          <p className="font-bold opacity-70 mb-1">Confiance :</p>
          <p>{suggestion.confidence}%</p>
          
          {suggestion.audioEvidence && (
            <div className="mt-3 flex items-center gap-2">
              <span className="font-mono bg-white/50 px-2 py-1 rounded-lg">{suggestion.audioEvidence}</span>
              <button className="flex items-center gap-1 bg-white hover:bg-white/80 px-3 py-1 rounded-lg transition-colors font-semibold">
                <Play className="w-3 h-3" /> Écouter
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompletedView({ jobId, onNewUpload }: { jobId: string; onNewUpload?: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white p-12 rounded-[2rem] shadow-sm border border-pink-100 text-center max-w-xl mx-auto">
      <div className="w-24 h-24 bg-pink-100 text-pink-500 rounded-full flex items-center justify-center mx-auto mb-6">
        <Check className="w-12 h-12" />
      </div>
      <h2 className="text-3xl font-extrabold text-pink-700 mb-4">Fiche générée avec succès !</h2>
      <p className="text-pink-600 mb-8 leading-relaxed">
        La fiche actualisée a été créée tout en conservant strictement la mise en page d&apos;origine. Les modifications sont surlignées en bleu.
      </p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
        <a 
          href={`/api/download/${jobId}`} 
          className="w-full sm:w-auto inline-flex items-center justify-center gap-3 bg-pink-500 hover:bg-pink-600 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-pink-500/20 transition-all hover:shadow-pink-500/40 active:scale-95"
        >
          <Download className="w-5 h-5" />
          TÉLÉCHARGER LE DOCX
        </a>
        {onNewUpload && (
          <button
            onClick={onNewUpload}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-pink-50 hover:bg-pink-100 text-pink-700 font-bold px-6 py-4 rounded-2xl transition-all"
          >
            Actualiser une autre fiche
          </button>
        )}
      </div>
    </motion.div>
  );
}
