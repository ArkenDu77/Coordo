import { NextRequest, NextResponse } from 'next/server';
import { createJob, getUploadPath, saveJob } from '@/lib/db';
import { convertToMasterDocx } from '@/lib/document-converter';
import fs from 'fs';

const MAX_DOCUMENT_BYTES = 24 * 1024 * 1024; // stay safely below Cloud Run HTTP/1 request limit
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024; // 1 GiB safety ceiling

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const docFile = (formData.get('doc') || formData.get('docx')) as File | null;
    const subject = String(formData.get('subject') || 'Autre');
    const courseName = String(formData.get('courseName') || 'Nouveau cours');
    const audioName = String(formData.get('audioName') || '');
    const audioSize = Number(formData.get('audioSize'));
    const audioMimeType = String(formData.get('audioMimeType') || 'audio/mpeg');

    if (!docFile || typeof docFile.arrayBuffer !== 'function' || !audioName) {
      return NextResponse.json({ error: 'La fiche et l’audio sont obligatoires.' }, { status: 400 });
    }
    if (!docFile.size || docFile.size > MAX_DOCUMENT_BYTES) {
      return NextResponse.json({ error: 'La fiche est vide ou dépasse 24 Mo. Réduisez le fichier puis réessayez.' }, { status: 400 });
    }
    if (!Number.isFinite(audioSize) || audioSize <= 0 || audioSize > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: 'Le fichier audio est vide ou trop volumineux.' }, { status: 400 });
    }
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: 'La clé Gemini du serveur n’est pas configurée.' }, { status: 500 });
    }

    const originalDocPath = getUploadPath(docFile.name);
    fs.writeFileSync(originalDocPath, Buffer.from(await docFile.arrayBuffer()));

    let conversionResult;
    try {
      conversionResult = await convertToMasterDocx(originalDocPath, docFile.name, docFile.type);
    } catch (error: any) {
      console.error('[Document conversion error]', error);
      try { fs.unlinkSync(originalDocPath); } catch {}
      return NextResponse.json(
        { error: error?.message || 'La fiche n’a pas pu être préparée.' },
        { status: 400 }
      );
    }

    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(audioSize),
          'X-Goog-Upload-Header-Content-Type': audioMimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: audioName } }),
        cache: 'no-store',
      }
    );

    if (!initRes.ok) {
      const detail = await initRes.text();
      console.error('[Gemini upload init failed]', initRes.status, detail.slice(0, 1000));
      return NextResponse.json({ error: 'Gemini n’a pas pu initialiser l’envoi audio.' }, { status: 502 });
    }

    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      return NextResponse.json({ error: 'Gemini n’a pas renvoyé de session d’envoi.' }, { status: 502 });
    }

    const job = createJob(subject, courseName, conversionResult.masterDocxPath, '');
    job.status = 'uploading';
    job.sourceDocumentName = docFile.name;
    job.sourceDocumentPath = originalDocPath;
    job.sourceFormat = conversionResult.sourceFormat;
    job.audioSizeBytes = audioSize;
    job.documentSizeBytes = docFile.size;
    job.progress = {
      percent: 5,
      stage: 'upload',
      stageLabel: 'Envoi de l’audio',
      message: 'Fiche préparée, envoi de l’audio...',
      stepDescription: 'Envoi de l’audio',
      etaFormatted: 'Temps restant estimé : quelques minutes',
      startedAt: Date.now(),
      elapsedSeconds: 0,
    };
    if (conversionResult.warning) job.conversionWarning = conversionResult.warning;
    job.geminiUploadUrl = uploadUrl;
    job.geminiMimeType = audioMimeType;
    saveJob(job);

    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    console.error('[Upload init error]', error);
    return NextResponse.json({ error: 'Impossible de démarrer l’envoi. Réessayez.' }, { status: 500 });
  }
}
