import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsInt, IsPositive } from 'class-validator';

export class UpdateItemCotadoFornecedorDto {
  @ApiProperty({
    description: 'Código do fornecedor no Celta (FOR_CODIGO). Precisa existir no ERP.',
    example: 250,
  })
  @IsDefined()
  @IsInt()
  @IsPositive()
  for_codigo!: number;
}
