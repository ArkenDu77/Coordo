import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { GoogleGenAI } from '@google/genai';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  PageBreak,
  BorderStyle,
} from 'docx';
// @ts-expect-error - heic-convert does not have bundled TS definitions
import heicConvert from 'heic-convert';

const execFileAsync = util.promisify(execFile);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type SupportedDocFormat =
  | 'docx'
  | 'pdf'
  | 'odt'
  | 'rtf'
  | 'txt'
  | 'html'
  | 'doc'
  | 'image';

export interface ConversionResult {
  masterDocxPath: string;
  sourceFormat: SupportedDocFormat;
  warning?: string;
}

export function detectDocumentFormat(filename: string, mimeType?: string): SupportedDocFormat | null {
  const name = filename.toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  if (name.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    return 'pdf';
  }
  if (name.endsWith('.odt') || mime === 'application/vnd.oasis.opendocument.text') {
    return 'odt';
  }
  if (name.endsWith('.rtf') || mime === 'application/rtf' || mime === 'text/rtf') {
    return 'rtf';
  }
  if (name.endsWith('.txt') || mime === 'text/plain') {
    return 'txt';
  }
  if (name.endsWith('.html') || name.endsWith('.htm') || mime === 'text/html') {
    return 'html';
  }
  if (name.endsWith('.doc') || mime === 'application/msword') {
    return 'doc';
  }
  if (
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.heic') ||
    name.endsWith('.heif') ||
    name.endsWith('.webp') ||
    mime.startsWith('image/')
  ) {
    return 'image';
  }
  return null;
}

/**
 * CAS TXT:
 * Le fichier ne contient pas de mise en page riche.
 * Créer un DOCX propre et minimal en conservant strictement le texte, les paragraphes et retours à la ligne.
 * Ne pas inventer une mise en page complexe.
 */
async function convertTxtToDocx(inputPath: string, outputPath: string): Promise<void> {
  const rawText = fs.readFileSync(inputPath, 'utf8');
  const lines = rawText.split(/\r?\n/);

  const paragraphs: Paragraph[] = lines.map((line) => {
    if (!line.trim()) {
      return new Paragraph({
        spacing: { after: 100 },
        children: [new TextRun({ text: '', font: 'Calibri', size: 22 })],
      });
    }
    return new Paragraph({
      spacing: { after: 120, line: 276 },
      children: [
        new TextRun({
          text: line,
          font: 'Calibri',
          size: 22, // 11pt
          color: '1F2937',
        }),
      ],
    });
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }, // 1 inch margins
          },
        },
        children: paragraphs.length > 0 ? paragraphs : [new Paragraph('')],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

/**
 * CAS ODT, RTF, HTML:
 * Conversion haute fidélité vers DOCX via Pandoc
 */
async function convertViaPandoc(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync('pandoc', [inputPath, '-o', outputPath]);
}

/**
 * CAS DOC (Word 97-2003):
 * Conversion via antiword/docbook ou pandoc
 */
async function convertDocToDocx(inputPath: string, outputPath: string): Promise<void> {
  try {
    const { stdout: docbookXml } = await execFileAsync('antiword', ['-x', 'db', inputPath]);
    const tmpDocbookPath = `${outputPath}.db.xml`;
    fs.writeFileSync(tmpDocbookPath, docbookXml, 'utf8');
    try {
      await execFileAsync('pandoc', ['-f', 'docbook', '-t', 'docx', tmpDocbookPath, '-o', outputPath]);
      if (fs.existsSync(tmpDocbookPath)) fs.unlinkSync(tmpDocbookPath);
      return;
    } catch {
      if (fs.existsSync(tmpDocbookPath)) fs.unlinkSync(tmpDocbookPath);
    }
  } catch {
    // Fallback: extract formatted text via antiword
  }

  try {
    const { stdout: text } = await execFileAsync('antiword', ['-m', 'UTF-8', inputPath]);
    const tmpTxtPath = `${outputPath}.txt`;
    fs.writeFileSync(tmpTxtPath, text, 'utf8');
    await convertTxtToDocx(tmpTxtPath, outputPath);
    if (fs.existsSync(tmpTxtPath)) fs.unlinkSync(tmpTxtPath);
  } catch (err) {
    throw new Error(`Échec de la conversion du fichier .doc: ${(err as Error).message}`);
  }
}

interface StructuredDocItem {
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'page_break';
  level?: 1 | 2 | 3;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  items?: string[];
  rows?: Array<
    Array<{
      text: string;
      isHeader?: boolean;
      bold?: boolean;
      align?: 'left' | 'center' | 'right';
    }>
  >;
}

interface GeminiDocumentReconstruction {
  title?: string;
  isUncertain?: boolean;
  uncertaintyReason?: string | null;
  elements: StructuredDocItem[];
}

/**
 * Reconstruit un fichier DOCX natif riche à partir de la structure analysée par Gemini OCR
 */
async function buildDocxFromStructuredElements(
  data: GeminiDocumentReconstruction,
  outputPath: string
): Promise<void> {
  const children: (Paragraph | Table)[] = [];

  if (data.title) {
    children.push(
      new Paragraph({
        text: data.title,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
      })
    );
  }

  for (const el of data.elements || []) {
    if (el.type === 'heading') {
      let hl: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1;
      if (el.level === 2) hl = HeadingLevel.HEADING_2;
      if (el.level === 3) hl = HeadingLevel.HEADING_3;

      let align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT;
      if (el.align === 'center') align = AlignmentType.CENTER;
      if (el.align === 'right') align = AlignmentType.RIGHT;

      children.push(
        new Paragraph({
          text: el.text || '',
          heading: hl,
          alignment: align,
          spacing: { before: 240, after: 120 },
        })
      );
    } else if (el.type === 'paragraph') {
      let align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT;
      if (el.align === 'center') align = AlignmentType.CENTER;
      if (el.align === 'right') align = AlignmentType.RIGHT;
      if (el.align === 'justify') align = AlignmentType.JUSTIFIED;

      children.push(
        new Paragraph({
          alignment: align,
          spacing: { after: 120, line: 276 },
          children: [
            new TextRun({
              text: el.text || '',
              bold: Boolean(el.bold),
              italics: Boolean(el.italic),
              font: 'Calibri',
              size: 22,
              color: el.color ? el.color.replace('#', '') : '1F2937',
            }),
          ],
        })
      );
    } else if (el.type === 'list' && Array.isArray(el.items)) {
      for (const item of el.items) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80 },
            children: [
              new TextRun({
                text: item,
                font: 'Calibri',
                size: 22,
                color: '1F2937',
              }),
            ],
          })
        );
      }
    } else if (el.type === 'table' && Array.isArray(el.rows) && el.rows.length > 0) {
      const tableRows = el.rows.map((row) => {
        const cells = row.map((cell) => {
          let cellAlign: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT;
          if (cell.align === 'center') cellAlign = AlignmentType.CENTER;
          if (cell.align === 'right') cellAlign = AlignmentType.RIGHT;

          return new TableCell({
            children: [
              new Paragraph({
                alignment: cellAlign,
                spacing: { before: 60, after: 60 },
                children: [
                  new TextRun({
                    text: cell.text || '',
                    bold: Boolean(cell.isHeader || cell.bold),
                    font: 'Calibri',
                    size: 20,
                    color: cell.isHeader ? '111827' : '374151',
                  }),
                ],
              }),
            ],
            shading: cell.isHeader
              ? { fill: 'F3F4F6' }
              : undefined,
            margins: {
              top: 100,
              bottom: 100,
              left: 120,
              right: 120,
            },
          });
        });
        return new TableRow({ children: cells });
      });

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows,
          margins: { top: 120, bottom: 120 },
        })
      );
    } else if (el.type === 'page_break') {
      children.push(
        new Paragraph({
          children: [new PageBreak()],
        })
      );
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }, // 1 inch
          },
        },
        children: children.length > 0 ? children : [new Paragraph('')],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

/**
 * CAS PDF & CAS IMAGE / SCAN:
 * Utilise l'OCR multimodal Gemini pour extraire fidèlement le contenu et la structure visuelle,
 * puis reconstruit un DOCX maître natif.
 */
async function convertMediaWithGeminiOcr(
  inputPath: string,
  outputPath: string,
  format: 'pdf' | 'image'
): Promise<{ warning?: string }> {
  let fileBuffer = fs.readFileSync(inputPath);
  let mimeType = format === 'pdf' ? 'application/pdf' : 'image/jpeg';

  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.png') mimeType = 'image/png';
  if (ext === '.webp') mimeType = 'image/webp';

  if (ext === '.heic' || ext === '.heif') {
    try {
      fileBuffer = await heicConvert({
        buffer: fileBuffer,
        format: 'JPEG',
        quality: 0.92,
      });
      mimeType = 'image/jpeg';
    } catch (e) {
      console.error('HEIC convert fallback error:', e);
    }
  }

  const base64Data = fileBuffer.toString('base64');

  const prompt = `
Tu es un expert en rétro-ingénierie documentaire et numérisation haute fidélité pour étudiants en médecine.
Tu dois analyser minutieusement ce document (${format === 'pdf' ? 'fichier PDF' : 'scan / photo de fiche de cours'}) et transcrire fidèlement l'intégralité de son contenu et de sa structure visuelle afin de reconstruire un document Word .docx maître équivalent.

DIRECTIVES CRUCIALES :
1. Extraction exhaustive : ne saute aucune ligne, aucun paragraphe, aucun tableau.
2. Structure :
   - Titres et sous-titres avec leur hiérarchie (level: 1, 2 ou 3).
   - Paragraphes : conserve les termes importants en gras (bold: true) ou italique (italic: true).
   - Tableaux : reproduis chaque ligne, chaque colonne et chaque cellule avec rigueur.
   - Listes : conserve toutes les puces ou énumérations dans "items".
3. Qualité / Incertitude :
   - Si le scan est parfaitement lisible, indique "isUncertain": false.
   - Si le document est flou, tronqué, manuscrit difficilement lisible ou si certains passages sont ambigus, indique "isUncertain": true avec une explication dans "uncertaintyReason".
4. Réponds UNIQUEMENT avec un JSON valide respectant cette structure exacte :
{
  "title": "Titre principal de la fiche ou null",
  "isUncertain": false,
  "uncertaintyReason": null,
  "elements": [
    { "type": "heading", "level": 1, "text": "...", "align": "left" },
    { "type": "paragraph", "text": "...", "bold": false, "italic": false, "align": "left" },
    { "type": "list", "items": ["..."] },
    { "type": "table", "rows": [[{ "text": "...", "isHeader": true, "bold": true, "align": "left" }]] },
    { "type": "page_break" }
  ]
}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: base64Data,
              mimeType,
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  let responseText = response.text || '{}';
  responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

  let parsed: GeminiDocumentReconstruction;
  try {
    parsed = JSON.parse(responseText);
  } catch (e) {
    console.error('Failed to parse Gemini OCR reconstruction JSON:', responseText, e);
    parsed = {
      title: 'Fiche Numérisée',
      isUncertain: true,
      uncertaintyReason: 'Format de réponse non structuré',
      elements: [
        {
          type: 'paragraph',
          text: responseText,
          bold: false,
          italic: false,
          align: 'left',
        },
      ],
    };
  }

  await buildDocxFromStructuredElements(parsed, outputPath);

  if (parsed.isUncertain) {
    return {
      warning: 'La conversion de cette fiche nécessite une vérification rapide avant actualisation.',
    };
  }
  return {};
}

/**
 * Normalisation et conversion haute fidélité vers un DOCX maître
 */
export async function convertToMasterDocx(
  inputFilePath: string,
  originalFilename: string,
  mimeType?: string
): Promise<ConversionResult> {
  const format = detectDocumentFormat(originalFilename, mimeType);
  if (!format) {
    throw new Error('Ce format de fichier n’est pas encore pris en charge.');
  }

  // CAS DOCX : pipeline natif intouché
  if (format === 'docx') {
    return {
      masterDocxPath: inputFilePath,
      sourceFormat: 'docx',
    };
  }

  // Emplacement du DOCX maître généré
  const outputDir = path.dirname(inputFilePath);
  const baseName = path.basename(inputFilePath, path.extname(inputFilePath));
  const masterDocxPath = path.join(outputDir, `${baseName}-master.docx`);

  let warning: string | undefined;

  switch (format) {
    case 'odt':
    case 'rtf':
    case 'html':
      await convertViaPandoc(inputFilePath, masterDocxPath);
      break;

    case 'txt':
      await convertTxtToDocx(inputFilePath, masterDocxPath);
      break;

    case 'doc':
      await convertDocToDocx(inputFilePath, masterDocxPath);
      break;

    case 'pdf':
    case 'image':
      const ocrRes = await convertMediaWithGeminiOcr(inputFilePath, masterDocxPath, format);
      warning = ocrRes.warning;
      break;

    default:
      throw new Error('Ce format de fichier n’est pas encore pris en charge.');
  }

  if (!fs.existsSync(masterDocxPath)) {
    throw new Error('La conversion vers le DOCX maître a échoué.');
  }

  return {
    masterDocxPath,
    sourceFormat: format,
    warning,
  };
}
