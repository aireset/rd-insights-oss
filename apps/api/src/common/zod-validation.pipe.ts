import type { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> { return this.schema.parse(value); }
}
