import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob, Suggestion } from '@/lib/db';
import { parseDocx, extractTextWithIds, applyPatches, serializeDocx } from '@/lib/docx';
import fs from 'fs';
import path from 'path';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: 'Job introuvable.' }, { status: 404 });
  if (!fs.existsSync(job.originalDocxPath)) {
    return NextResponse.json({ error: 'Le document maître n’est plus disponible. Relancez l’actualisation.' }, { status: 410 });
  }

  const body = await req.json().catch(() => null);
  const suggestions = body?.suggestions as Suggestion[] | undefined;
  if (!Array.isArray(suggestions)) {
    return NextResponse.json({ error: 'Suggestions invalides.' }, { status: 400 });
  }

  try {
    const docxBuffer = fs.readFileSync(job.originalDocxPath);
    const { zip, doc } = parseDocx(docxBuffer);
    const blocks = extractTextWithIds(doc);
    const validBlockIds = new Set(blocks.map((block) => block.stableId));

    const safeSuggestions = suggestions.filter((suggestion) =>
      suggestion &&
      ['ADD', 'DELETE', 'REPLACE', 'VERIFY'].includes(suggestion.type) &&
      ['pending', 'accepted', 'rejected'].includes(suggestion.status) &&
      (!suggestion.targetBlock || validBlockIds.has(suggestion.targetBlock))
    );

    applyPatches(doc, safeSuggestions, blocks);
    const outBuffer = serializeDocx(zip, doc);
    const outPath = path.join(process.cwd(), 'data', 'uploads', `export-${id}.docx`);
    fs.writeFileSync(outPath, outBuffer);

    job.suggestions = safeSuggestions;
    job.status = 'completed';
    job.progress = {
      ...job.progress,
      percent: 100,
      stage: 'completed',
      stageLabel: 'Fiche générée',
      message: 'Fiche actualisée prête au téléchargement.',
      estimatedRemainingSeconds: 0,
      etaFormatted: '0 s',
    };
    saveJob(job);

    return NextResponse.json({ downloadUrl: `/api/download/${id}` });
  } catch (error) {
    console.error('[DOCX export error]', error);
    return NextResponse.json({ error: 'La fiche actualisée n’a pas pu être générée.' }, { status: 500 });
  }
}
