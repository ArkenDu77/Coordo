import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId manquant.' }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: 'Session introuvable.' }, { status: 404 });

  // Finalization already persisted server-side.
  if (job.geminiFileName && job.geminiFileUri) {
    return NextResponse.json({ offset: 'final' });
  }
  if (!job.geminiUploadUrl) {
    return NextResponse.json({ error: 'Session d’envoi expirée.' }, { status: 410 });
  }

  try {
    const queryRes = await fetch(job.geminiUploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'query',
      },
      cache: 'no-store',
    });

    if (!queryRes.ok) {
      return NextResponse.json({ error: 'Impossible de reprendre la session.' }, { status: 502 });
    }

    const status = queryRes.headers.get('x-goog-upload-status');
    if (status === 'active') {
      return NextResponse.json({ offset: queryRes.headers.get('x-goog-upload-size-received') || '0' });
    }
    if (status === 'final') return NextResponse.json({ offset: 'final' });
    return NextResponse.json({ error: 'Session Gemini annulée.' }, { status: 410 });
  } catch (error) {
    console.error('[Upload status error]', error);
    return NextResponse.json({ error: 'Erreur réseau pendant la reprise.' }, { status: 502 });
  }
}
