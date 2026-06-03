import { YAML } from 'bun';
import path from 'node:path';

const filePath = path.join(process.cwd(), process.argv[2]);
const file = Bun.file(filePath);
const content = await file.text();
const metadata = YAML.parse(content) as Record<string, any>;

metadata['aspects']['dataplex-types.global.overview'] = {
  content: 'sample updated documentation',
  contentType: 'MARKDOWN'
}

const updatedContent = YAML.stringify(metadata, null, 2);
file.write(updatedContent);
