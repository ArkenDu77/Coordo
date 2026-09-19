import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob } from '@/lib/db';
import { parseDocx, extractTextWithIds, applyPatches, serializeDocx } from '@/lib/docx';
import fs from 'fs';
import path from 'path';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const body = await req.json();
  const suggestions = body.suggestions; // Updated suggestions from client
  
  if (!suggestions) return NextResponse.json({ error: 'Missing suggestions' }, { status: 400 });

  try {
    // 1. Read original DOCX
    const docxBuffer = fs.readFileSync(job.originalDocxPath);
    const { zip, doc } = parseDocx(docxBuffer);
    const blocks = extractTextWithIds(doc);

    // 2. Apply accepted patches
    applyPatches(doc, suggestions, blocks);

    // 3. Serialize back to DOCX
    const outBuffer = serializeDocx(zip, doc);

    // 4. Save to a new file
    const outPath = path.join(process.cwd(), 'data', 'uploads', `export-${id}.docx`);
    fs.writeFileSync(outPath, outBuffer);

    // Return the download URL
    return NextResponse.json({ downloadUrl: `/api/download/${id}` });
  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to apply patches' }, { status: 500 });
  }
}
