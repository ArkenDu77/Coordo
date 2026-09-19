import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob } from '@/lib/db';

export async function POST(req: NextRequest) {
  const jobId = req.headers.get('x-job-id');
  const offset = req.headers.get('x-offset');
  const isLast = req.headers.get('x-is-last') === 'true';
  const contentLength = req.headers.get('content-length') || '0';

  if (!jobId || offset === null) {
    return NextResponse.json({ error: 'Missing headers' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job || !job.geminiUploadUrl) {
    return NextResponse.json({ error: 'Job invalid or no upload session' }, { status: 400 });
  }

  if (!req.body) {
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }

  try {
    const command = isLast ? 'upload, finalize' : 'upload';

    const fetchOptions: any = {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': command,
        'X-Goog-Upload-Offset': offset,
        'Content-Length': contentLength,
      },
      body: req.body,
      duplex: 'half' // Required by Node's fetch when passing a stream
    };

    const chunkRes = await fetch(job.geminiUploadUrl, fetchOptions);

    if (!chunkRes.ok) {
      const text = await chunkRes.text();
      console.error("Gemini chunk upload failed:", text);
      return NextResponse.json({ error: 'Chunk upload failed' }, { status: 500 });
    }

    if (isLast) {
      const fileInfo = await chunkRes.json();
      job.geminiFileName = fileInfo.file.name;
      job.geminiFileUri = fileInfo.file.uri;
      job.progress = {
        ...job.progress,
        percent: 20,
        stage: 'upload',
        stageLabel: 'Envoi des fichiers',
        message: 'Envoi terminé, préparation de l’audio...',
        stepDescription: 'Envoi des fichiers',
      };
      saveJob(job);
    } else {
      const totalBytes = job.audioSizeBytes || 1;
      const currentBytes = parseInt(offset, 10) + parseInt(contentLength, 10);
      const frac = Math.min(1, currentBytes / totalBytes);
      const stagePercent = Math.min(19, Math.max(5, Math.round(5 + frac * 15)));
      job.progress = {
        ...job.progress,
        percent: stagePercent,
        stage: 'upload',
        stageLabel: 'Envoi des fichiers',
        message: `Envoi du cours audio (${Math.round(frac * 100)}%)...`,
        stepDescription: 'Envoi des fichiers',
      };
      saveJob(job);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error forwarding chunk:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
