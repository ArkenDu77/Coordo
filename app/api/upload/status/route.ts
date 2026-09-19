import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');

  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job || !job.geminiUploadUrl) {
    return NextResponse.json({ error: 'Job not found or invalid' }, { status: 404 });
  }

  try {
    const queryRes = await fetch(job.geminiUploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'query'
      }
    });

    if (!queryRes.ok) {
       return NextResponse.json({ error: 'Query failed' }, { status: queryRes.status });
    }

    const status = queryRes.headers.get('x-goog-upload-status');
    if (status === 'active') {
      const received = queryRes.headers.get('x-goog-upload-size-received') || '0';
      return NextResponse.json({ offset: received });
    } else if (status === 'final') {
       return NextResponse.json({ offset: 'final' });
    } else {
       return NextResponse.json({ error: 'Session cancelled or unknown status' }, { status: 400 });
    }

  } catch (e) {
    console.error('Error checking status:', e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
