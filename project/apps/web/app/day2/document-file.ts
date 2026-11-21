export const MAX_DOCUMENT_CHARACTERS = 12_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WORD_XML_BYTES = 8 * 1024 * 1024;
const WORD_NAMESPACES = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
];

async function readWordFile(file: File) {
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const zip = new ZipReader(new BlobReader(file), { useWebWorkers: false, checkSignature: true });
  const oversized = new Error('Nội dung bên trong tệp Word quá lớn. Hãy chọn một tệp nhỏ hơn.');
  try {
    const main = (await zip.getEntries()).find(entry => entry.filename === 'word/document.xml');
    if (!main || main.directory || main.encrypted) throw new Error('Missing or protected Word document');
    if (main.uncompressedSize > MAX_WORD_XML_BYTES) throw oversized;

    let xml = '';
    let bytes = 0;
    let decoder: TextDecoder | undefined;
    await main.getData(new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength;
        if (bytes > MAX_WORD_XML_BYTES) throw oversized;
        decoder ??= new TextDecoder(
          chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le' :
          chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8',
          { fatal: true },
        );
        xml += decoder.decode(chunk, { stream: true });
      },
    }));
    xml += decoder?.decode() ?? '';
    if (/<!DOCTYPE/i.test(xml)) throw new Error('Unexpected XML declaration');

    const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
    const namespace = root.namespaceURI ?? '';
    if (root.localName !== 'document' || !WORD_NAMESPACES.includes(namespace)) throw new Error('Invalid Word XML');
    const body = root.getElementsByTagNameNS(namespace, 'body')[0];
    if (!body) throw new Error('Missing Word document body');

    const parts: string[] = [];
    for (const element of body.getElementsByTagNameNS(namespace, '*')) {
      switch (element.localName) {
        case 'p':
          parts.push('\n');
          break;
        case 't':
          parts.push(element.textContent ?? '');
          break;
        case 'tab':
          if (element.parentElement?.localName === 'r') parts.push('\t');
          break;
        case 'br':
        case 'cr':
          parts.push('\n');
          break;
      }
    }
    return parts.join('');
  } catch (error) {
    if (error === oversized) throw error;
    throw new Error('Không đọc được tệp Word. Hãy chọn tệp .docx hợp lệ và bỏ mật khẩu nếu có.');
  } finally {
    await zip.close();
  }
}

export async function readDocumentFile(file: File) {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'docx' && extension !== 'txt') throw new Error('Hãy chọn tệp .docx hoặc .txt (UTF-8).');
  if (file.size > MAX_FILE_BYTES) throw new Error('Tệp vượt quá giới hạn 10 MB.');

  let text: string;
  if (extension === 'docx') {
    text = await readWordFile(file);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (text.includes('\0')) throw new Error('Invalid text file');
    } catch {
      throw new Error('Không đọc được tệp văn bản. Hãy lưu lại tệp .txt ở dạng UTF-8.');
    }
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Tệp chưa có văn bản để tóm tắt.');
  if (text.length > MAX_DOCUMENT_CHARACTERS) {
    throw new Error('Văn bản vượt quá 12.000 ký tự. Hãy rút gọn tệp hoặc dán đoạn cần tóm tắt.');
  }
  return text;
}
