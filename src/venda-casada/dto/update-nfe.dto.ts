import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString } from 'class-validator';

export class UpdateNfeDto {
  @ApiProperty({
    description: 'NF-e da encomenda (grava na coluna `nfe`). Vazio ou null limpa o valor.',
    example: '35260912345678000190550010000123451000123456',
    nullable: true,
  })
  @IsDefined()
  @IsString()
  nfe!: string | null;
}
