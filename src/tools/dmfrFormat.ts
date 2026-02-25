import { z } from 'zod';
import * as fs from 'fs';
import { TransitlandCLI } from '../cli';

// eslint-disable-next-line @typescript-eslint/naming-convention
export const DmfrFormatInputSchema = z.object({
  filePath: z.string().describe('Absolute path to a .dmfr.json file to format in-place'),
});

export type DmfrFormatInput = z.infer<typeof DmfrFormatInputSchema>;

export interface DmfrFormatOutput {
  success: boolean;
  message: string;
}

export async function runDmfrFormat(
  cli: TransitlandCLI,
  input: DmfrFormatInput,
  signal?: AbortSignal,
): Promise<DmfrFormatOutput> {
  if (!fs.existsSync(input.filePath)) {
    return { success: false, message: `File not found: ${input.filePath}` };
  }

  await cli.exec(['dmfr', 'format', '--save', input.filePath], signal);
  return { success: true, message: `Formatted: ${input.filePath}` };
}
