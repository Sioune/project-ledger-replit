export type AccountTicket = {scope:string; epoch:number};
/** Invalidate every in-flight operation before a session may change. */
export class AccountEpoch {
 private scope:string|null=null;
 private epoch=0;
 get current(){return this.scope;}
 capture():AccountTicket|null{return this.scope?{scope:this.scope,epoch:this.epoch}:null;}
 valid(ticket:AccountTicket|null):ticket is AccountTicket{return !!ticket&&ticket.scope===this.scope&&ticket.epoch===this.epoch;}
 suspend(){this.epoch++;}
 set(scope:string|null){if(scope!==this.scope){this.scope=scope;this.epoch++;}}
}
