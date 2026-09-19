import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJob } from '@/lib/db';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const outPath = path.join(process.cwd(), 'data', 'uploads', `export-${id}.docx`);
  
  if (!fs.existsSync(outPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const job = getJob(id);
  const name = job ? `FC actu ${job.courseName} 2026-2027.docx` : 'Export.docx';

  const fileBuffer = fs.readFileSync(outPath);
  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    },
  });
}
