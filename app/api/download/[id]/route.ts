import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJob } from '@/lib/db';

function asciiFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim() || 'fiche-actualisee.docx';
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const outPath = path.join(process.cwd(), 'data', 'uploads', `export-${id}.docx`);
  if (!fs.existsSync(outPath)) {
    return NextResponse.json({ error: 'Fiche exportée introuvable.' }, { status: 404 });
  }

  const job = getJob(id);
  const rawName = job ? `FC actu ${job.courseName} 2026-2027.docx` : 'fiche-actualisee.docx';
  const fallbackName = asciiFilename(rawName);
  const fileBuffer = fs.readFileSync(outPath);

  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
      'Cache-Control': 'no-store',
    },
  });
}
