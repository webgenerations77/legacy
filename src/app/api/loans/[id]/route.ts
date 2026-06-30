import { createEncryptedRecordItemRoute } from "@/lib/encrypted-record-item-route";
export const { PUT, DELETE } = createEncryptedRecordItemRoute({ model: "loan" });
