import { formatBadgeLabel, inferDocumentFormat } from '@cbct/shared';

/** 上传前的宽松体积预检：PDF 沿用 LeePDF 512 MB，其余章节格式 100 MB；
 *  服务端仍会按 OCR 配置（50/200 MB）严格校验并给出最终错误。 */
export const MAX_PDF_IMPORT_BYTES = 512 * 1048576;
export const MAX_SECTION_IMPORT_BYTES = 100 * 1048576;

/** 上传入口接受的所有扩展名；与服务端 detectDocumentFormat 保持一致。 */
const IMPORT_EXTENSIONS = [
  'pdf', 'epub', 'txt', 'md', 'markdown', 'mdown', 'mkd', 'docx', 'fb2', 'mobi', 'azw', 'azw3', 'prc',
];

export function isImportFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMPORT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function importSizeLimit(name: string): number {
  return inferDocumentFormat(name) === 'pdf' ? MAX_PDF_IMPORT_BYTES : MAX_SECTION_IMPORT_BYTES;
}

export function fileFormatLabel(name: string): string {
  return formatBadgeLabel(inferDocumentFormat(name));
}
