// src/common/types/uploaded-file.ts

/**
 * Arquivo recebido via upload multipart.
 *
 * Substitui o tipo global `Express.Multer.File` (que vinha de @types/multer) após a
 * migração para o Fastify. Os nomes dos campos são mantidos iguais aos do Multer para
 * que os consumidores (`file.originalname`, `file.buffer`, `file.mimetype`) continuem
 * funcionando sem alteração.
 */
export interface UploadedFileData {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}
