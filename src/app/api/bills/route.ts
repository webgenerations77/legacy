import { createEncryptedRecordRoute } from "@/lib/encrypted-record-route";

export const { GET, POST } = createEncryptedRecordRoute({ model: "bill", listKey: "bills" });
