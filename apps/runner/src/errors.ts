/** Runner-side wire errors mapped onto HTTP-ish statuses. */
export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotFoundError";
  }
}