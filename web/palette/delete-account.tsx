import { deleteAccount } from "#web/sync/account.ts";
import { exportAll } from "#web/transfer/transfer.ts";
import { Button } from "#web/ui/button.tsx";
import { Confirm } from "./confirm.tsx";

export function DeleteAccount(props: { onCancel: () => void }) {
  return (
    <Confirm
      title="Delete your account and all your notes?"
      action="Delete account"
      busy="Deleting…"
      run={deleteAccount}
      onCancel={props.onCancel}
    >
      Your notes will be erased from Literal and this device. This can't be undone.{" "}
      <Button variant="link" onClick={exportAll}>
        Export your notes
      </Button>{" "}
      first.
    </Confirm>
  );
}
