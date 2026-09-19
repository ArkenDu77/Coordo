import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const jobId = req.headers.get('x-job-id');
  const offsetHeader = req.headers.get('x-offset');
  const chunkSizeHeader = req.headers.get('x-chunk-size');
  const isLast = req.headers.get('x-is-last') === 'true';

  if (!jobId || offsetHeader === null || chunkSizeHeader === null) {
    return NextResponse.json({ error: 'En-têtes d’upload manquants.' }, { status: 400 });
  }

  const offset = Number(offsetHeader);
  const chunkSize = Number(chunkSizeHeader);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    return NextResponse.json({ error: 'Position ou taille de chunk invalide.' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Session d’envoi introuvable.' }, { status: 404 });
  }

  // Si le dernier chunk a déjà été finalisé (réponse perdue côté navigateur), répondre
  // idempotemment au lieu de tenter de renvoyer les mêmes octets.
  if (job.geminiFileName && job.geminiFileUri) {
    return NextResponse.json({ success: true, finalized: true });
  }

  if (!job.geminiUploadUrl) {
    return NextResponse.json({ error: 'Session d’envoi expirée.' }, { status: 409 });
  }
  if (!req.body) {
    return NextResponse.json({ error: 'Chunk audio vide.' }, { status: 400 });
  }

  try {
    const command = isLast ? 'upload, finalize' : 'upload';
    const upstream = await fetch(job.geminiUploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': command,
        'X-Goog-Upload-Offset': String(offset),
        'Content-Length': String(chunkSize),
        'Content-Type': 'application/octet-stream',
      },
      body: req.body,
      // Required by Node fetch/undici when forwarding a request stream.
      duplex: 'half',
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[Gemini chunk upload failed]', upstream.status, text.slice(0, 1000));
      return NextResponse.json(
        { error: 'Gemini a refusé un morceau du fichier audio.', upstreamStatus: upstream.status },
        { status: 502 }
      );
    }

    if (isLast) {
      const fileInfo = await upstream.json().catch(() => null) as any;
      if (!fileInfo?.file?.name || !fileInfo?.file?.uri) {
        console.error('[Gemini finalize] missing file metadata', fileInfo);
        return NextResponse.json({ error: 'Finalisation audio incomplète.' }, { status: 502 });
      }
      job.geminiFileName = fileInfo.file.name;
      job.geminiFileUri = fileInfo.file.uri;
      // The resumable URL contains credentials. It is no longer needed after finalization.
      job.geminiUploadUrl = undefined;
      job.progress = {
        ...job.progress,
        percent: 20,
        stage: 'upload',
        stageLabel: 'Envoi de l’audio',
        message: 'Envoi terminé, préparation de l’audio...',
        stepDescription: 'Envoi terminé',
      };
      saveJob(job);
      return NextResponse.json({ success: true, finalized: true });
    }

    const totalBytes = job.audioSizeBytes || 1;
    const currentBytes = Math.min(totalBytes, offset + chunkSize);
    const fraction = Math.min(1, currentBytes / totalBytes);
    const stagePercent = Math.min(19, Math.max(5, Math.round(5 + fraction * 15)));
    job.progress = {
      ...job.progress,
      percent: stagePercent,
      stage: 'upload',
      stageLabel: 'Envoi de l’audio',
      message: `Envoi du cours audio (${Math.round(fraction * 100)}%)...`,
      stepDescription: 'Envoi de l’audio',
    };
    saveJob(job);

    return NextResponse.json({ success: true, nextOffset: currentBytes });
  } catch (error) {
    console.error('[Audio chunk proxy error]', error);
    return NextResponse.json({ error: 'Erreur réseau pendant l’envoi audio.' }, { status: 502 });
  }
}
