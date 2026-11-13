import type { PayloadRequest, TypedUser, Where } from 'payload'

/**
 * The usual buyer rule, for `access.buyerOf`: a signed-in person reads the kits they bought and the
 * kits they activated (a kit given away with its slip belongs to whoever activated it).
 */
export const buyerOrKeeper = ({ user }: { req: PayloadRequest; user: TypedUser }): Where | false =>
  user?.id === undefined || user.id === null ? false : { or: [{ buyer: { equals: user.id } }, { activatedBy: { equals: user.id } }] }
