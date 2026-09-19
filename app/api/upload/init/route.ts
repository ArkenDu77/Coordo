import { NextRequest, NextResponse } from 'next/server';
import { createJob, getUploadPath, saveJob } from '@/lib/db';
import { convertToMasterDocx } from '@/lib/document-converter';
import fs from 'fs';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const docFile = (formData.get('doc') || formData.get('docx')) as File;
    const subject = formData.get('subject') as string || 'Autre';
    const courseName = formData.get('courseName') as string || 'Nouveau cours';
    
    const audioName = formData.get('audioName') as string;
    const audioSize = parseInt(formData.get('audioSize') as string, 10);
    const audioMimeType = formData.get('audioMimeType') as string;

    if (!docFile || !audioName) {
      return NextResponse.json({ error: 'Fichiers manquants' }, { status: 400 });
    }

    // Save uploaded original document to disk
    const originalDocPath = getUploadPath(docFile.name);
    fs.writeFileSync(originalDocPath, Buffer.from(await docFile.arrayBuffer()));

    // Normalisation et conversion haute fidélité vers un DOCX maître
    let conversionResult;
    try {
      conversionResult = await convertToMasterDocx(originalDocPath, docFile.name, docFile.type);
    } catch (convErr: any) {
      console.error("Document conversion error:", convErr);
      return NextResponse.json({ 
        error: convErr?.message || 'Erreur lors de la conversion du document vers DOCX.' 
      }, { status: 400 });
    }

    // 1. Initialize resumable upload session with Gemini API
    const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': audioSize.toString(),
        'X-Goog-Upload-Header-Content-Type': audioMimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: audioName } })
    });

    if (!initRes.ok) {
      const text = await initRes.text();
      console.error("Gemini init upload failed:", text);
      return NextResponse.json({ error: 'Erreur init Gemini' }, { status: 500 });
    }

    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      return NextResponse.json({ error: 'Pas d\'URL d\'upload reçue de Gemini' }, { status: 500 });
    }

    // 2. Create job with master DOCX and save conversion metadata
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
      stageLabel: 'Envoi des fichiers',
      message: 'Fiche transmise, initialisation du transfert audio...',
      stepDescription: 'Envoi des fichiers',
      etaFormatted: 'Temps restant estimé : quelques minutes',
      startedAt: Date.now(),
      elapsedSeconds: 0,
    };
    if (conversionResult.warning) {
      job.conversionWarning = conversionResult.warning;
    }
    job.geminiUploadUrl = uploadUrl;
    job.geminiMimeType = audioMimeType;
    saveJob(job);

    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Upload init failed' }, { status: 500 });
  }
}
