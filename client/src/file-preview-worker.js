import {read,utils} from 'xlsx';

self.onmessage=event=>{
 try{
  const workbook=read(event.data,{type:'array',sheetRows:201,cellHTML:false,cellFormula:false,cellDates:false});
  const sheets=workbook.SheetNames.slice(0,30).map(name=>{
   const sheet=workbook.Sheets[name],range=utils.decode_range(sheet['!ref']||'A1');
   const rows=[],lastRow=Math.min(range.e.r,range.s.r+199),lastCol=Math.min(range.e.c,range.s.c+49);
   for(let r=range.s.r;r<=lastRow;r++){
    const row=[];
    for(let c=range.s.c;c<=lastCol;c++){
     const cell=sheet[utils.encode_cell({r,c})];
     row.push(cell?String(cell.w??cell.v??'').slice(0,2000):'');
    }
    rows.push(row);
   }
   const full=utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
   return{name,rows,truncated:full.e.r>lastRow||full.e.c>lastCol};
  });
  self.postMessage({sheets,truncatedSheets:workbook.SheetNames.length>30});
 }catch{self.postMessage({error:'This spreadsheet could not be previewed. You can still download the original file.'});}
};
