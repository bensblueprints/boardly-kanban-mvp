import React from 'react';
import {BrainCircuit,Plug} from 'lucide-react';
import SettingsShell from './SettingsShell.jsx';
import CompanyAI from './CompanyAI.jsx';
export default function DepartmentSettings({entity,section='ai',onBack}){
 const sections=[{id:'ai',label:'AI & models',icon:BrainCircuit,description:'Inherit Company AI or choose the model for this Department and its Boards.'},{id:'connectors',label:'Connectors',icon:Plug,description:'Choose a saved Organization or Company AI connection.'}];
 return <SettingsShell scope="Department" name={entity.name} sections={sections} section={section==='connectors'?'connectors':'ai'} onSelect={id=>{location.hash=`#/collection/${entity.id}/settings/${id}`;}} onBack={onBack}>
  <section aria-label="Default department AI" className="space-y-4"><h3 className="font-semibold">Default AI for this department</h3><CompanyAI key={entity.id} scopeKind="department" scopeId={entity.id}/></section>
 </SettingsShell>;
}
