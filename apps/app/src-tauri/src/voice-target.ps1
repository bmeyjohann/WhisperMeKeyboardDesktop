param([switch]$Persistent)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName Accessibility
# IAccessible2 is a capability fallback, not an application-name exception.
# ABI slots follow LinuxA11y/IAccessible2 api/{Accessible2,AccessibleText}.idl.
Add-Type -ReferencedAssemblies Accessibility @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface WMServiceProvider {
 [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result);
}
public sealed class WMEditorException : Exception { public WMEditorException(string message):base(message){} }
public sealed class WhisperMeIA2 : IDisposable {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h,uint id,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out object a);
 [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible a,int start,int count,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)]object[] children,out int got);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int IntOut(IntPtr p,out int v);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int LongOut(IntPtr p,out IntPtr v);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int StringOut(IntPtr p,[MarshalAs(UnmanagedType.BStr)]out string v);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int TextOut(IntPtr p,int s,int e,[MarshalAs(UnmanagedType.BStr)]out string v);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SelectionOut(IntPtr p,int i,out int s,out int e);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetInt(IntPtr p,int i);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetRange(IntPtr p,int i,int s,int e);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int LinkOut(IntPtr p,int i,out IntPtr v);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int IndexOut(IntPtr p,int i,out int v);
 [StructLayout(LayoutKind.Sequential)] struct TextSelection { public IntPtr startObj;public int startOffset;public IntPtr endObj;public int endOffset;public byte startIsActive; }
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SelectionsOut(IntPtr p,out IntPtr selections,out int count);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetSelections(IntPtr p,int count,ref TextSelection selection);
 sealed class TextNode { public IntPtr Text;public string Key,Value,Raw;public int Base;public int[] Map; }
 List<TextNode> nodes=new List<TextNode>();
 IntPtr selectionContainer;
 IntPtr ia, text;
 IAccessible accessible;
 public string Identity, FullText, Label, Hint, Attributes, WindowTitle;
 public int Start, End, ProcessId;
 public bool? IsMultiline;
 public List<Dictionary<string,object>> RelatedFields() {
  var output=new List<Dictionary<string,object>>();
  if(Label!="Subject"&&Label!="Betreff"&&Label!="Message body"&&Label!="Nachrichtentext")return output;
  IntPtr h=GetForegroundWindow();uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=ProcessId)return output;
  Guid iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");object root;
  if(AccessibleObjectFromWindow(h,0xfffffffc,ref iid,out root)!=0)return output;
  var pending=new Queue<IAccessible>();pending.Enqueue(root as IAccessible);IAccessible subject=null,body=null;int budget=200;
  while(pending.Count>0&&budget-->0){IAccessible node=pending.Dequeue();if(node==null)continue;int role=Convert.ToInt32(node.get_accRole(0));string name=(role==42||role==15)?node.get_accName(0)??"":"";
   if(role==42&&(name=="Subject"||name=="Betreff")){if(subject!=null)return output;subject=node;continue;}
   if(role==15&&(name=="Message body"||name=="Nachrichtentext")){if(body!=null)return output;body=node;continue;}
   if(role==11||role==12||role==33||role==35||role==42||role==46||role==15)continue;
   int count=Math.Min(node.accChildCount,Math.Min(100,Math.Max(0,budget-pending.Count))),got;object[] children=new object[count];AccessibleChildren(node,0,count,children,out got);for(int i=0;i<got;i++){IAccessible child=children[i] as IAccessible;if(child!=null)pending.Enqueue(child);}
  }
  // Require both semantic anchors within this one foreground compose window.
  // Never read recipient values, mail lists, other windows, or unmatched fields.
  if(subject==null||body==null)return output;
  IAccessible other=(Label=="Subject"||Label=="Betreff")?body:subject;
  if((Convert.ToInt32(other.get_accState(0))&0x20000000)!=0)return output;
  try{
   int limit=Object.ReferenceEquals(other,subject)?512:2048,previewBudget=64;
   string value=Preview(other,limit+1,0,ref previewBudget);
   int take=Math.Min(value.Length,limit);if(take>0&&take<value.Length&&char.IsHighSurrogate(value[take-1])&&char.IsLowSurrogate(value[take]))take--;
   output.Add(new Dictionary<string,object>{{"fieldRole",Object.ReferenceEquals(other,subject)?"email_subject":"email_body"},{"fieldLabel",other.get_accName(0)??""},{"text",value.Substring(0,take)},{"truncated",value.Length>take}});
  }catch{output.Clear();}return output;
 }
 static string Preview(IAccessible a,int limit,int depth,ref int budget) {
  if(depth>12||budget--<=0)throw new WMEditorException("Related field structure exceeds the preview limit");
  IntPtr p=Query(a,"24FD2FFB-3AAD-4a08-8335-A3AD89C0FB4B"),hyper=IntPtr.Zero;
  if(p==IntPtr.Zero)throw new WMEditorException("Related field preview unavailable");
  try {int count;Check(Slot<IntOut>(p,17)(p,out count));if(count<0)throw new WMEditorException("Related field preview unavailable");
   string raw;Check(Slot<TextOut>(p,10)(p,0,Math.Min(count,limit),out raw));raw=raw??"";StringBuilder value=new StringBuilder();
   for(int i=0;i<raw.Length&&value.Length<limit;i++){
    if(raw[i]!='\ufffc'){value.Append(raw[i]);continue;}
    if(hyper==IntPtr.Zero)hyper=Query(a,"6B4F8BBF-F1F2-418a-B35E-A195BC4103B9");if(hyper==IntPtr.Zero)throw new WMEditorException("Related field preview unavailable");
    int index;Check(Slot<IndexOut>(hyper,24)(hyper,i,out index));IntPtr link;Check(Slot<LinkOut>(hyper,23)(hyper,index,out link));
    try{IAccessible child=Marshal.GetObjectForIUnknown(link) as IAccessible;if(child==null)throw new WMEditorException("Related field preview unavailable");int role=Convert.ToInt32(child.get_accRole(0));if(role!=20&&role!=41&&role!=42&&role!=15&&role!=30)throw new WMEditorException("Related field preview unavailable");value.Append(Preview(child,limit-value.Length,depth+1,ref budget));}finally{if(link!=IntPtr.Zero)Marshal.Release(link);}
   }
   return value.ToString();
  }finally{if(hyper!=IntPtr.Zero)Marshal.Release(hyper);Marshal.Release(p);}
 }
 static T Slot<T>(IntPtr p,int slot) { return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(p),slot*IntPtr.Size),typeof(T)); }
 static IntPtr Query(IAccessible a,string guid) { WMServiceProvider sp=a as WMServiceProvider; if(sp==null)return IntPtr.Zero;Guid service=new Guid("E89F726E-C4F4-4c19-BB19-B647D7FA8478"),iid=new Guid(guid);IntPtr p;return sp.QueryService(ref service,ref iid,out p)==0?p:IntPtr.Zero; }
 static void Check(int hr) { if(hr<0)Marshal.ThrowExceptionForHR(hr); }
 static string Key(IAccessible a) { IntPtr p=Query(a,"E89F726E-C4F4-4c19-BB19-B647D7FA8478");if(p==IntPtr.Zero)throw new WMEditorException("Embedded object has no verifiable identity");try{int id;IntPtr h;Check(Slot<IntOut>(p,41)(p,out id));Check(Slot<LongOut>(p,42)(p,out h));return h.ToInt64()+":"+id;}finally{Marshal.Release(p);} }
 TextNode Build(IAccessible a,int depth,int offset) {
  if(depth>24||nodes.Count>=4096)throw new WMEditorException("Editor structure is too complex; copy the result instead");
  IntPtr p=Query(a,"24FD2FFB-3AAD-4a08-8335-A3AD89C0FB4B");if(p==IntPtr.Zero)throw new WMEditorException("Non-text embedded objects require copy recovery");
  TextNode node=new TextNode();node.Text=p;node.Base=offset;nodes.Add(node);node.Key=Key(a);
  int count;Check(Slot<IntOut>(p,17)(p,out count));if(count<0||count>1000000)throw new WMEditorException("Field is too large for voice editing");
  string raw;Check(Slot<TextOut>(p,10)(p,0,count,out raw));raw=raw??"";if(raw.Length!=count)throw new WMEditorException("The editor text length could not be verified");
  node.Raw=raw;node.Map=new int[count+1];StringBuilder value=new StringBuilder();IntPtr hyper=IntPtr.Zero;
  try { for(int i=0;i<count;i++) { node.Map[i]=value.Length;
   if(raw[i]!='\ufffc')value.Append(raw[i]);else {
    if(hyper==IntPtr.Zero)hyper=Query(a,"6B4F8BBF-F1F2-418a-B35E-A195BC4103B9");if(hyper==IntPtr.Zero)throw new WMEditorException("Embedded text cannot be resolved; copy the result instead");
    int index;Check(Slot<IndexOut>(hyper,24)(hyper,i,out index));IntPtr link;Check(Slot<LinkOut>(hyper,23)(hyper,index,out link));
    if(link==IntPtr.Zero)throw new WMEditorException("Embedded text cannot be resolved");
    try { IAccessible child=Marshal.GetObjectForIUnknown(link) as IAccessible;if(child==null)throw new WMEditorException("Non-text embedded objects require copy recovery");
     int role=Convert.ToInt32(child.get_accRole(0));if(role!=20&&role!=41&&role!=42&&role!=15&&role!=30)throw new WMEditorException("Non-text embedded objects require copy recovery");
     value.Append(Build(child,depth+1,offset+value.Length).Value);
    }finally{Marshal.Release(link);}
   }
   if(value.Length+offset>1000000)throw new WMEditorException("Field is too large for voice editing");
  }}finally{if(hyper!=IntPtr.Zero)Marshal.Release(hyper);}
  node.Map[count]=value.Length;node.Value=value.ToString();return node;
 }
 int Offset(IntPtr obj,int offset) { IAccessible a=Marshal.GetObjectForIUnknown(obj) as IAccessible;if(a==null)throw new WMEditorException("Selection endpoint is not an accessible text object");string key=Key(a);foreach(TextNode node in nodes)if(node.Key==key&&offset>=0&&offset<node.Map.Length)return node.Base+node.Map[offset];throw new WMEditorException("Selection extends beyond the captured editor"); }
 public static WhisperMeIA2 Focused() {
  IntPtr h=GetForegroundWindow();uint pid;GetWindowThreadProcessId(h,out pid);
  Guid iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");object root;
  if(AccessibleObjectFromWindow(h,0xfffffffc,ref iid,out root)!=0)return null;
  IAccessible a=root as IAccessible;if(a==null)return null;
  for(int depth=0;depth<24;depth++){object f=a.accFocus;IAccessible next=f as IAccessible;if(next==null){if(f is int && (int)f!=0)next=a.get_accChild(f) as IAccessible;if(next==null)break;} if(Object.ReferenceEquals(a,next))break;a=next;}
  // Only the actual focused editable object; never search arbitrary descendants.
  int state=Convert.ToInt32(a.get_accState(0));
  if((state&4)==0 || (state&(1|0x40|0x20000000))!=0)return null;
  WhisperMeIA2 result=new WhisperMeIA2();result.accessible=a;
  try {
   result.ia=Query(a,"E89F726E-C4F4-4c19-BB19-B647D7FA8478");
   result.text=Query(a,"24FD2FFB-3AAD-4a08-8335-A3AD89C0FB4B");
   if(result.ia==IntPtr.Zero||result.text==IntPtr.Zero){result.Dispose();return null;}
   int states;Check(Slot<IntOut>(result.ia,35)(result.ia,out states));
   if((states&8)==0){result.Dispose();return null;} // IA2_STATE_EDITABLE
   result.IsMultiline=(states&0x200)!=0 ? (bool?)true : ((states&0x2000)!=0 ? (bool?)false : null);
   int id;IntPtr window;Check(Slot<IntOut>(result.ia,41)(result.ia,out id));Check(Slot<LongOut>(result.ia,42)(result.ia,out window));
   result.ProcessId=(int)pid;result.Identity="ia2:"+pid+":"+window.ToInt64()+":"+id;
   result.Label=a.get_accName(0)??"";result.Hint=a.get_accDescription(0)??"";
   string attrs;int attrHr=Slot<StringOut>(result.ia,45)(result.ia,out attrs);result.Attributes=attrHr==0?attrs??"":"";
   StringBuilder title=new StringBuilder(257);GetWindowText(h,title,257);result.WindowTitle=title.ToString();
   result.Read();return result;
  }catch{result.Dispose();throw;}
 }
 public void Read() {
  foreach(TextNode old in nodes)Marshal.Release(old.Text);nodes.Clear();
  TextNode root=Build(accessible,0,0);FullText=root.Value;
  if(nodes.Count>1) {
   if(selectionContainer==IntPtr.Zero)selectionContainer=Query(accessible,"2118B599-733F-43D0-A569-0B31D125ED9A");
   if(selectionContainer==IntPtr.Zero){
    int first=int.MaxValue,last=-1,caret=-1;
    foreach(TextNode node in nodes){int nestedSelections;Check(Slot<IntOut>(node.Text,7)(node.Text,out nestedSelections));if(nestedSelections>1)throw new WMEditorException("A single text selection is required");
     if(nestedSelections==1){int s,e;Check(Slot<SelectionOut>(node.Text,9)(node.Text,0,out s,out e));if(s>e){int t=s;s=e;e=t;}if(s<0||e>=node.Map.Length)throw new WMEditorException("Invalid nested selection");
      for(int i=s;i<e;i++)if(node.Raw[i]!='\ufffc'){first=Math.Min(first,node.Base+node.Map[i]);last=Math.Max(last,node.Base+node.Map[i+1]);}
     }
     int local;int hr=Slot<IntOut>(node.Text,5)(node.Text,out local);if(hr==0&&local>=0&&local<node.Map.Length)caret=node.Base+node.Map[local];
    }
    if(last>=0){Start=first;End=last;}else if(caret>=0){Start=End=caret;}else throw new WMEditorException("The nested editor caret could not be verified");return;
   }
   IntPtr ranges;int n;Check(Slot<SelectionsOut>(selectionContainer,3)(selectionContainer,out ranges,out n));
   try {if(n!=1||ranges==IntPtr.Zero)throw new WMEditorException("A single verified text selection is required");TextSelection range=(TextSelection)Marshal.PtrToStructure(ranges,typeof(TextSelection));Start=Offset(range.startObj,range.startOffset);End=Offset(range.endObj,range.endOffset);}
   finally{if(ranges!=IntPtr.Zero){for(int i=0;i<n&&i<4096;i++){TextSelection r=(TextSelection)Marshal.PtrToStructure(IntPtr.Add(ranges,i*Marshal.SizeOf(typeof(TextSelection))),typeof(TextSelection));if(r.startObj!=IntPtr.Zero)Marshal.Release(r.startObj);if(r.endObj!=IntPtr.Zero)Marshal.Release(r.endObj);}Marshal.FreeCoTaskMem(ranges);}}
   if(Start>End){int swap=Start;Start=End;End=swap;}return;
  }
  int count;Check(Slot<IntOut>(text,17)(text,out count));if(count<0||count>1000000)throw new WMEditorException("Field is too large for voice editing");
  string value;Check(Slot<TextOut>(text,10)(text,0,count,out value));FullText=value??"";
  if(FullText.Length!=count)throw new WMEditorException("The editor text length could not be verified; copy the result instead");
  if(FullText.IndexOf('\ufffc')>=0)throw new WMEditorException("This editor contains embedded text objects; copy the result instead");
  int selections;Check(Slot<IntOut>(text,7)(text,out selections));
  if(selections==0){Check(Slot<IntOut>(text,5)(text,out Start));End=Start;}
  else if(selections==1){Check(Slot<SelectionOut>(text,9)(text,0,out Start,out End));if(Start>End){int swap=Start;Start=End;End=swap;}}
  else throw new WMEditorException("A single caret or selection is required");
  if(Start<0||End<Start||End>count)throw new WMEditorException("The editor returned an invalid selection");
 }
 void Endpoint(int offset,out IntPtr obj,out int raw) {for(int i=nodes.Count-1;i>=0;i--){TextNode node=nodes[i];if(offset<node.Base||offset>node.Base+node.Value.Length)continue;for(int j=0;j<node.Map.Length;j++)if(node.Base+node.Map[j]==offset){obj=node.Text;raw=j;return;}}throw new WMEditorException("Caret position cannot be mapped to the editor");}
 public void Select(int start,int end) {
  Read();
  if(nodes.Count==1){if(start==end)Check(Slot<SetInt>(text,15)(text,start));else Check(Slot<SetRange>(text,16)(text,0,start,end));return;}
  TextSelection range=new TextSelection();Endpoint(start,out range.startObj,out range.startOffset);Endpoint(end,out range.endObj,out range.endOffset);
  if(selectionContainer==IntPtr.Zero){
   if(start==end){Check(Slot<SetInt>(range.startObj,15)(range.startObj,range.startOffset));return;}
   if(start==0&&end==FullText.Length){Check(Slot<SetRange>(text,16)(text,0,0,nodes[0].Raw.Length));return;}
   if(range.startObj==range.endObj){Check(Slot<SetRange>(range.startObj,16)(range.startObj,0,range.startOffset,range.endOffset));return;}
   throw new WMEditorException("This editor cannot select a range across text objects; copy the result instead");
  }
  int hr=Slot<SetSelections>(selectionContainer,4)(selectionContainer,1,ref range);if(hr!=0)throw new WMEditorException("The requested editor selection could not be set");
 }
 public void Dispose(){foreach(TextNode node in nodes)Marshal.Release(node.Text);nodes.Clear();if(selectionContainer!=IntPtr.Zero){Marshal.Release(selectionContainer);selectionContainer=IntPtr.Zero;}if(text!=IntPtr.Zero){Marshal.Release(text);text=IntPtr.Zero;}if(ia!=IntPtr.Zero){Marshal.Release(ia);ia=IntPtr.Zero;}}
}
'@
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WhisperMeEditSelection {
    public sealed class Patch { public int Start, End; public string Text; public bool Changed { get { return Start != End || Text.Length != 0; } } }
    static bool SplitsPair(string s,int at) { return at>0 && at<s.Length && char.IsHighSurrogate(s[at-1]) && char.IsLowSurrogate(s[at]); }
    public static Patch Difference(string before,string after) {
        int start=0,limit=Math.Min(before.Length,after.Length);
        while(start<limit && before[start]==after[start])start++;
        if(SplitsPair(before,start)||SplitsPair(after,start))start--;
        int suffix=0;
        while(suffix<before.Length-start && suffix<after.Length-start && before[before.Length-1-suffix]==after[after.Length-1-suffix])suffix++;
        if(SplitsPair(before,before.Length-suffix)||SplitsPair(after,after.Length-suffix))suffix--;
        return new Patch { Start=start, End=before.Length-suffix, Text=after.Substring(start,after.Length-suffix-start) };
    }
    [DllImport("user32.dll", EntryPoint="SendMessageW")]
    public static extern IntPtr SetSelection(IntPtr hwnd, uint message, IntPtr start, IntPtr end);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hwnd, uint message, out int start, out int end);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")]
    static extern IntPtr ReadTextRaw(IntPtr hwnd, uint message, IntPtr capacity, StringBuilder text);
    public static IntPtr ReadText(IntPtr hwnd,uint message,IntPtr capacity,StringBuilder text) {
        StringBuilder name=new StringBuilder(256);GetClassName(hwnd,name,256);
        if(name.ToString().IndexOf("RichEdit",StringComparison.OrdinalIgnoreCase)<0)return ReadTextRaw(hwnd,message,capacity,text);
        // WM_GETTEXT is system-marshalled across processes. Do not send pointer-
        // bearing WM_USER messages such as EM_GETTEXTEX to another process.
        // RichEdit selection offsets count each paragraph break once; normalize
        // its expanded CRLF representation to LF while reserving double capacity.
        int size=checked(capacity.ToInt32()*2);StringBuilder raw=new StringBuilder(size);
        ReadTextRaw(hwnd,message,new IntPtr(size),raw);
        string canonical=raw.ToString().Replace("\r\n","\n").Replace("\r","\n");
        text.Clear();text.Append(canonical);return new IntPtr(canonical.Length);
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")]
    public static extern IntPtr WriteText(IntPtr hwnd, uint message, IntPtr unused, string text);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")]
    public static extern int GetStyle(IntPtr hwnd, int index);
}
'@
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WhisperMeFieldShape {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetStyle(IntPtr h, int i);
}
'@
function Get-FieldRole([string]$Label,[string]$Hint,[string]$Id) {
    # Classify semantic labels/identifiers, never process name alone.
    if ($Id -match '^(msgSubject|subject)$' -or $Label -match '^(Subject|Betreff)\s*:?$') { return 'email_subject' }
    if ($Id -match '^(messageEditor|content-frame)$' -or $Label -match '^(Message Body|Message body|Nachrichtentext|Email body)$') { return 'email_body' }
    if ($Label -match '^(E-?mail( address)?|Email-Adresse|E-Mail-Adresse)\s*:?$' -or $Id -match '^(toAddrInput|ccAddrInput|bccAddrInput)$') { return 'email_address' }
    if ($Label -match '^(Search|Suche|Suchen)\s*:?$' -or $Id -match '^(search|searchbox)$') { return 'search' }
    return 'unknown'
}
function Limit-FieldMetadata([string]$Text) {
    $length=[Math]::Min($Text.Length,256)
    if ($length -gt 0 -and [char]::IsHighSurrogate($Text[$length-1])) { $length-- }
    return $Text.Substring(0,$length)
}
function Assert-RelatedFields($request,$target) {
    if ($null -eq $request.snapshot.relatedFields -or @($request.snapshot.relatedFields).Count -eq 0) { return }
    $expected=@($request.snapshot.relatedFields)
    $current=$target.RelatedFields()
    if ($expected.Count -ne 1 -or $current.Count -ne 1) { throw 'Related editor context changed or is unavailable; result was not inserted' }
    foreach ($key in @('fieldRole','fieldLabel','text')) {
        if (-not [string]::Equals([string]$expected[0].$key,[string]$current[0][$key],[StringComparison]::Ordinal)) { throw 'Related editor context changed; result was not inserted' }
    }
    if ($expected[0].truncated -isnot [bool] -or $expected[0].truncated -ne $current[0]['truncated']) { throw 'Related editor context changed; result was not inserted' }
}
function Wait-TargetFocus([string]$Identity) {
    # Chromium can briefly report its document instead of the edited control after
    # SetValue. Observe only: never call SetFocus or activate a previous window.
    $stable=0
    for ($attempt=0;$attempt -lt 12;$attempt++) {
        $focused=[System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and ($focused.GetRuntimeId() -join ':') -ceq $Identity) { $stable++ } else { $stable=0 }
        if ($stable -ge 2) { return $true }
        Start-Sleep -Milliseconds 20
    }
    return $false
}
function Get-TextRange($Document,[string]$Text,[int]$Start,[int]$End) {
    $range=$Document.Clone()
    if ($Start -gt 0) {
        $prefix=$Document.FindText($Text.Substring(0,$Start),$false,$false)
        if ($null -eq $prefix) { throw 'The changed text range could not be located. Copy the result instead.' }
        $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,$prefix,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
    }
    if ($End -eq $Start) {
        $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,$range,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    } elseif ($End -lt $Text.Length) {
        $prefix=$Document.FindText($Text.Substring(0,$End),$false,$false)
        if ($null -eq $prefix) { throw 'The changed text range could not be located. Copy the result instead.' }
        $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,$prefix,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
    }
    if (-not [string]::Equals($range.GetText(-1),$Text.Substring($Start,$End-$Start),[StringComparison]::Ordinal)) { throw 'The changed text range could not be verified. Copy the result instead.' }
    return $range
}
function Get-RequestedCaret($request) {
    $text = [string]$request.text
    if ($text.IndexOf([char]0) -ge 0) { throw 'Null characters cannot be inserted safely into this editor' }
    if ($text.Length -gt 1000000) { throw 'Result is too large for voice editing' }
    $position = $text.Length
    if ($null -ne $request.cursorPosition) {
        $candidate = [double]$request.cursorPosition
        if ($candidate -lt 0 -or $candidate -gt $text.Length -or [Math]::Truncate($candidate) -ne $candidate) { throw 'Invalid result caret position; result was not inserted' }
        $position = [int]$candidate
    }
    if ($position -gt 0 -and $position -lt $text.Length -and [char]::IsHighSurrogate($text[$position-1]) -and [char]::IsLowSurrogate($text[$position])) { throw 'Invalid UTF-16 caret position; result was not inserted' }
    return $position
}
function Invoke-IA2Target($request,$target) {
    try {
        $package = [Diagnostics.Process]::GetProcessById($target.ProcessId).ProcessName
        if ($package -match '^(WindowsTerminal|OpenConsole|conhost|cmd|powershell|pwsh)$') { throw 'Terminal editing is unsupported. Copy the result instead.' }
        $fieldId = ''
        if ($target.Attributes -match '(?:^|;)id:([^;]*);') { $fieldId = $Matches[1] }
        $snapshot = @{
            identity=$target.Identity;fullText=$target.FullText
            textBeforeCursor=$target.FullText.Substring(0,$target.Start)
            selectedText=$target.FullText.Substring($target.Start,$target.End-$target.Start)
            textAfterCursor=$target.FullText.Substring($target.End)
            packageName=$package;appName=$package;windowTitle=(Limit-FieldMetadata $target.WindowTitle)
            fieldLabel=(Limit-FieldMetadata $target.Label);fieldHint=(Limit-FieldMetadata $target.Hint)
            fieldRole=(Get-FieldRole $target.Label $target.Hint $fieldId);isMultiline=$target.IsMultiline
            editorAdapter='ia2'
        }
        if ($snapshot.fieldRole -eq 'email_address') { $snapshot.fieldType='email' }
        if ($null -eq $target.IsMultiline) { $snapshot.Remove('isMultiline') }
        if ($request.action -ne 'apply') {
            $metadataClock=[Diagnostics.Stopwatch]::StartNew()
            try {
                $related=$target.RelatedFields()
                if ($related.Count -gt 0) { $snapshot.relatedFields=@($related.ToArray()) }
            } catch { } # Optional metadata must never disable an otherwise verifiable field.
            $snapshot.captureTimings=@{relatedFieldsMs=[Math]::Round($metadataClock.Elapsed.TotalMilliseconds,1);totalMs=[Math]::Round($captureClock.Elapsed.TotalMilliseconds,1)}
            return ($snapshot | ConvertTo-Json -Depth 6 -Compress)
        }
        $caret = Get-RequestedCaret $request
        foreach ($key in @('identity','fullText','textBeforeCursor','selectedText','textAfterCursor')) {
            if (-not [string]::Equals($snapshot[$key],$request.snapshot.$key,[StringComparison]::Ordinal)) { throw 'The target field or selection changed; result was not inserted' }
        }
        Assert-RelatedFields $request $target
        Add-Type -AssemblyName System.Windows.Forms
        $replacement = [string]$request.text
        $patch=[WhisperMeEditSelection]::Difference($snapshot.fullText,$replacement)
        $previousClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
        try {
            if ($patch.Changed) {
            if ($patch.Text.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetText($patch.Text) }
            $fresh = [WhisperMeIA2]::Focused()
            try {
                if ($null -eq $fresh -or $fresh.Identity -cne $target.Identity -or $fresh.FullText -cne $target.FullText -or $fresh.Start -ne $target.Start -or $fresh.End -ne $target.End) { throw 'The target field or selection changed; result was not inserted' }
            } finally { if ($null -ne $fresh) { $fresh.Dispose() } }
            $target.Select($patch.Start,$patch.End)
            Start-Sleep -Milliseconds 40
            $fresh = [WhisperMeIA2]::Focused()
            try {
                if ($null -eq $fresh -or $fresh.Identity -cne $target.Identity -or $fresh.FullText -cne $snapshot.fullText -or $fresh.Start -ne $patch.Start -or $fresh.End -ne $patch.End) { throw 'The editor selection could not be verified before paste; result was not inserted' }
            } finally { if ($null -ne $fresh) { $fresh.Dispose() } }
            if ($patch.Text.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait('^v') } else { [System.Windows.Forms.SendKeys]::SendWait('{DELETE}') }
            }
            $verified = $false
            for ($attempt=0;$attempt -lt 20;$attempt++) {
                Start-Sleep -Milliseconds 50
                $fresh = [WhisperMeIA2]::Focused()
                try {
                    if ($null -eq $fresh -or $fresh.Identity -cne $target.Identity) { throw 'Focus changed after paste; check the field before copying' }
                    if ([string]::Equals($fresh.FullText,$replacement,[StringComparison]::Ordinal)) { $verified=$true;break }
                } finally { if ($null -ne $fresh) { $fresh.Dispose() } }
            }
            if (-not $verified) { throw 'Paste could not be verified. Check the field before copying the result.' }
            $target.Select($caret,$caret)
            Start-Sleep -Milliseconds 60
            $fresh = [WhisperMeIA2]::Focused()
            try {
                if ($null -eq $fresh -or $fresh.Identity -cne $target.Identity -or $fresh.FullText -cne $replacement -or $fresh.Start -ne $caret -or $fresh.End -ne $caret) { throw 'Text was inserted but caret placement could not be verified. Check the field before continuing.' }
            } finally { if ($null -ne $fresh) { $fresh.Dispose() } }
        } finally {
            if ($patch.Changed -and $patch.Text.Length -gt 0 -and [System.Windows.Forms.Clipboard]::GetText() -ceq $patch.Text) {
                if ($null -ne $previousClipboard) { [System.Windows.Forms.Clipboard]::SetDataObject($previousClipboard,$true) } else { [System.Windows.Forms.Clipboard]::Clear() }
            }
        }
        return (@{applied=$true;cursorPosition=$caret} | ConvertTo-Json -Compress)
    } finally { $target.Dispose() }
}
function Invoke-VoiceTarget($request) {
if ($request.action -eq 'helper.ping') { return (@{ helperPid = $PID } | ConvertTo-Json -Compress) }
$captureClock = [Diagnostics.Stopwatch]::StartNew()
$captureTimings = @{}
$stage = 'focused element'
try {
$element = [System.Windows.Automation.AutomationElement]::FocusedElement
$captureTimings.focusMs = [Math]::Round($captureClock.Elapsed.TotalMilliseconds, 1)
if ($null -eq $element -or $element.Current.IsPassword) { throw 'Choose a non-password text field' }
$pattern = $null
$nativeClassProbe=New-Object System.Text.StringBuilder 256
[void][WhisperMeEditSelection]::GetClassName([IntPtr]$element.Current.NativeWindowHandle,$nativeClassProbe,256)
$preferNative=$nativeClassProbe.ToString() -match '^(Edit|RichEdit.*|WindowsForms10\.(?:EDIT|RichEdit[^.]*)\..*)$'
$stage = 'text pattern discovery'
if (-not $preferNative -and $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
$stage = 'document and selection'
$document = $pattern.DocumentRange
$selection = $pattern.GetSelection()
if ($selection.Count -ne 1) { throw 'A single caret or selection is required' }
$before = $document.Clone()
$before.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $selection[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
$after = $document.Clone()
$after.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $selection[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
$stage = 'reading document text'
$fullText = $document.GetText(1000001)
if ($fullText.Length -gt 1000000) { throw 'Field is too large for voice editing' }
$rawDocumentText = $fullText
$beforeText = $before.GetText(-1)
$selectedText = $selection[0].GetText(-1)
$afterText = $after.GetText(-1)

# Chromium includes CSS-generated placeholders in both TextPattern and ValuePattern.
# Generated text cannot be selected as editable DOM text. Probe only short Chromium
# fields with a collapsed caret; restore the exact original range before returning.
# Never infer emptiness from a phrase, label, colour, or an empty selection alone.
$value = $null
[void]$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
$collapsed = $selection[0].CompareEndpoints(
    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $selection[0],
    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -eq 0
if ($collapsed -and $fullText.Length -gt 0 -and $element.Current.FrameworkId -eq 'Chrome') {
    $confirmedEmpty = $false
    if ($null -ne $value -and $value.Current.Value.Length -eq 0) {
        # Native HTML inputs can expose an object-replacement marker for a placeholder.
        $confirmedEmpty = $true
    } elseif ($fullText.Length -le 512 -and $element.Current.IsEnabled -and
        $document.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute) -ceq $false) {
        $stage = 'checking editable placeholder'
        $savedRange = $selection[0].Clone()
        $identity = $element.GetRuntimeId() -join ':'
        try {
            if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $identity) {
                throw 'Focus moved while checking the editor; capture the field again'
            }
            $document.Select()
            # Select is asynchronous in Chromium. Give its event loop time to update,
            # then require two stable reads rather than trusting the previous caret.
            Start-Sleep -Milliseconds 40
            $probe = $pattern.GetSelection()
            if ($probe.Count -ne 1) { throw 'The editor returned an ambiguous selection; capture the field again' }
            $probeText = $probe[0].GetText(-1)
            Start-Sleep -Milliseconds 20
            $confirmed = $pattern.GetSelection()
            if ($confirmed.Count -ne 1 -or
                -not [string]::Equals($probeText, $confirmed[0].GetText(-1), [StringComparison]::Ordinal) -or
                -not [string]::Equals($rawDocumentText, $pattern.DocumentRange.GetText(-1), [StringComparison]::Ordinal)) {
                throw 'The target field or selection changed; capture the field again'
            }
            $confirmedEmpty = $probeText.Length -eq 0 -and $confirmed[0].CompareEndpoints(
                [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $confirmed[0],
                [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -eq 0
        } finally {
            # Never move focus back to a previous application.
            if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -ceq $identity) {
                # Re-anchor in a fresh text range: Chromium's saved parent-boundary
                # caret can select the wrong DOM offset after selecting the document.
                $restoreRange = $pattern.DocumentRange.Clone()
                if (-not $confirmedEmpty -and $beforeText.Length -gt 0) {
                    $prefix = $restoreRange.FindText($beforeText, $false, $false)
                    if ($null -eq $prefix) { throw 'The editor caret could not be restored; capture the field again' }
                    $restoreRange.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
                        $prefix, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
                }
                $restoreRange.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                    $restoreRange, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
                $restoreRange.Select()
            }
        }
        Start-Sleep -Milliseconds 60
        $restored = $pattern.GetSelection()
        if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $identity -or
            $restored.Count -ne 1) {
            throw 'The editor caret could not be restored; capture the field again'
        }
        # Chromium can express the same caret as a parent-node boundary after Select.
        # Verify its exact UTF-16 text position, not internal node affinity.
        $restoredDocument = $pattern.DocumentRange
        $restoredBefore = $restoredDocument.Clone()
        $restoredBefore.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
            $restored[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $restoredAfter = $restoredDocument.Clone()
        $restoredAfter.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,
            $restored[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        if (-not [string]::Equals($rawDocumentText, $restoredDocument.GetText(-1), [StringComparison]::Ordinal) -or
            (-not $confirmedEmpty -and -not [string]::Equals($beforeText, $restoredBefore.GetText(-1), [StringComparison]::Ordinal)) -or
            -not [string]::Equals($selectedText, $restored[0].GetText(-1), [StringComparison]::Ordinal) -or
            (-not $confirmedEmpty -and -not [string]::Equals($afterText, $restoredAfter.GetText(-1), [StringComparison]::Ordinal))) {
            throw ('The editor caret could not be restored (before {0}/{1}, selection {2}/{3}, after {4}/{5}); capture the field again' -f $beforeText.Length,$restoredBefore.GetText(-1).Length,$selectedText.Length,$restored[0].GetText(-1).Length,$afterText.Length,$restoredAfter.GetText(-1).Length)
        }
        $document = $restoredDocument
        $selection = $restored
    }
    if ($confirmedEmpty) { $fullText = ''; $beforeText = ''; $selectedText = ''; $afterText = '' }
}
} else {
$stage = 'native edit selection'
    # Standard Windows edit controls may offer only ValuePattern. Read their UTF-16 selection
    # through EM_GETSEL; never assume an unknown browser/editor caret is at the end.
    $value = $null
    [void]$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
    $handle = [IntPtr]$element.Current.NativeWindowHandle
    $className = New-Object System.Text.StringBuilder 256
    [void][WhisperMeEditSelection]::GetClassName($handle, $className, 256)
    if ($handle -eq [IntPtr]::Zero -or $className.ToString() -notmatch '^(Edit|RichEdit.*|WindowsForms10\.(?:EDIT|RichEdit[^.]*)\..*)$') {
        $stage = 'IAccessible2 focused editor'
        $ia2Target = [WhisperMeIA2]::Focused()
        if ($null -ne $ia2Target) { return (Invoke-IA2Target $request $ia2Target) }
        throw 'This editor does not expose a verifiable caret or selection. Copy the result instead.'
    }
    if (([WhisperMeEditSelection]::GetStyle($handle, -16) -band 0x20) -ne 0) {
        throw 'Choose a non-password text field'
    }
    $start = 0; $end = 0
    [void][WhisperMeEditSelection]::SendMessage($handle, 0x00B0, [ref]$start, [ref]$end)
    $nativeText = New-Object System.Text.StringBuilder 1000002
    [void][WhisperMeEditSelection]::ReadText($handle, 0x000D, [IntPtr]1000002, $nativeText)
    $fullText = $nativeText.ToString()
    if ($start -lt 0 -or $end -lt $start -or $end -gt $fullText.Length) {
        throw 'This editor returned an invalid selection; result was not inserted'
    }
    $beforeText = $fullText.Substring(0, $start)
    $selectedText = $fullText.Substring($start, $end - $start)
    $afterText = $fullText.Substring($end)
}
$snapshot = @{
    identity = ($element.GetRuntimeId() -join ':')
    fullText = $fullText
    textBeforeCursor = $beforeText
    selectedText = $selectedText
    textAfterCursor = $afterText
    packageName = [System.Diagnostics.Process]::GetProcessById($element.Current.ProcessId).ProcessName
    fieldLabel = (Limit-FieldMetadata $element.Current.Name)
    fieldHint = (Limit-FieldMetadata $element.Current.HelpText)
    fieldRole = (Get-FieldRole $element.Current.Name $element.Current.HelpText $element.Current.AutomationId)
    editorAdapter = 'uia'
}
$snapshot.appName = $snapshot.packageName
if ($snapshot.fieldRole -eq 'email_address') { $snapshot.fieldType='email' }
$ancestor = $element
for ($depth=0;$depth -lt 16;$depth++) {
    if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { $snapshot.windowTitle = Limit-FieldMetadata $ancestor.Current.Name;break }
    $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
    if ($null -eq $parent -or $parent.Current.ProcessId -ne $element.Current.ProcessId) { break }
    $ancestor = $parent
}
$captureTimings.textMs = [Math]::Round($captureClock.Elapsed.TotalMilliseconds, 1)
$stage = 'field capabilities'
if ($snapshot.fullText.Length -gt 1000000) { throw 'Field is too large for voice editing' }
$shapeClass = New-Object System.Text.StringBuilder 256
$shapeHandle = [IntPtr]$element.Current.NativeWindowHandle
[void][WhisperMeFieldShape]::GetClassName($shapeHandle, $shapeClass, 256)
$nativeEdit = $shapeClass.ToString() -match '^(Edit|RichEdit.*|WindowsForms10\.(?:EDIT|RichEdit[^.]*)\..*)$'
if ($nativeEdit) {
    if (([WhisperMeFieldShape]::GetStyle($shapeHandle, -16) -band 0x20) -ne 0) { throw 'Choose a non-password text field' }
    $snapshot.isMultiline = ([WhisperMeFieldShape]::GetStyle($shapeHandle, -16) -band 4) -ne 0
}
if ($request.action -eq 'apply') {
$stage = 'target validation'
    $caret = Get-RequestedCaret $request
    foreach ($key in @('identity', 'fullText', 'textBeforeCursor', 'selectedText', 'textAfterCursor')) {
        if (-not [string]::Equals($snapshot[$key], $request.snapshot.$key, [StringComparison]::Ordinal)) { throw 'The target field or selection changed; result was not inserted' }
    }
    $value = $null
$stage = 'applying text'
    $replacement=[string]$request.text
    $patch=[WhisperMeEditSelection]::Difference($snapshot.fullText,$replacement)
    [void]$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)
    if ($null -ne $value -and $value.Current.IsReadOnly) { throw 'Target field is read-only' }
    if (-not $nativeEdit) {
        $readOnly=$document.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
        if ($readOnly -isnot [bool] -or $readOnly) { throw 'Target field does not expose verified writable text. Copy the result instead.' }
    }
    if ($nativeEdit) {
        # A persistent UIA client can activate a richer provider between requests.
        # Recognized native controls retain their verified native replacement path.
        if (([WhisperMeEditSelection]::GetStyle($shapeHandle, -16) -band 0x800) -ne 0) {
            throw 'Target field is read-only'
        }
        if ($patch.Changed) {
            $nativeBefore=New-Object System.Text.StringBuilder 1000002
            [void][WhisperMeEditSelection]::ReadText($shapeHandle,0x000D,[IntPtr]1000002,$nativeBefore)
            if ($nativeBefore.ToString() -cne $snapshot.fullText -or ([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $snapshot.identity) { throw 'The target field changed; result was not inserted' }
            $originalStart=0;$originalEnd=0
            [void][WhisperMeEditSelection]::SendMessage($shapeHandle,0x00B0,[ref]$originalStart,[ref]$originalEnd)
            if ($originalStart -ne $snapshot.textBeforeCursor.Length -or $originalEnd -ne ($snapshot.textBeforeCursor.Length+$snapshot.selectedText.Length)) { throw 'The target selection changed; result was not inserted' }
            [void][WhisperMeEditSelection]::SetSelection($shapeHandle,0x00B1,[IntPtr]$patch.Start,[IntPtr]$patch.End)
            $rangeStart=0;$rangeEnd=0
            [void][WhisperMeEditSelection]::SendMessage($shapeHandle,0x00B0,[ref]$rangeStart,[ref]$rangeEnd)
            if ($rangeStart -ne $patch.Start -or $rangeEnd -ne $patch.End) { throw 'The changed native range could not be verified; result was not inserted' }
            if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $snapshot.identity) { throw 'Focus moved before insertion; result was not inserted' }
            # EM_REPLACESEL changes only the verified range and retains native undo.
            [void][WhisperMeEditSelection]::WriteText($shapeHandle,0x00C2,[IntPtr]1,$patch.Text)
        }
        $nativeText = New-Object System.Text.StringBuilder 1000002
        [void][WhisperMeEditSelection]::ReadText($shapeHandle, 0x000D, [IntPtr]1000002, $nativeText)
        if ($nativeText.ToString() -cne [string]$request.text) { throw 'Native insertion could not be verified. Check the field before copying.' }
    } elseif ($patch.Changed) {
        # Rich text editors can expose TextPattern without a writable ValuePattern.
        # Never send keys to a terminal, read-only document, or a different focused element.
        $control = $element.Current.ControlType
        $readOnly = $document.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
        if (($control -ne [System.Windows.Automation.ControlType]::Edit -and
             $control -ne [System.Windows.Automation.ControlType]::Document) -or
            $readOnly -isnot [bool] -or $readOnly -or
            $snapshot.packageName -match '^(WindowsTerminal|OpenConsole|conhost|cmd|powershell|pwsh)$') {
            throw 'This editor does not support verified text replacement. Copy the result instead.'
        }
        Add-Type -AssemblyName System.Windows.Forms
        $previousClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
        try {
            if ($patch.Text.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetText($patch.Text) }
            if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $snapshot.identity) {
                throw 'Focus moved to another field; result was not inserted'
            }
            if (-not [string]::Equals($pattern.DocumentRange.GetText(-1), $rawDocumentText, [StringComparison]::Ordinal) -or
                $pattern.GetSelection()[0].CompareEndpoints(
                    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $selection[0],
                    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start) -ne 0 -or
                $pattern.GetSelection()[0].CompareEndpoints(
                    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $selection[0],
                    [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -ne 0) {
                throw 'The target field or selection changed; result was not inserted'
            }
            $changedRange=Get-TextRange $pattern.DocumentRange $snapshot.fullText $patch.Start $patch.End
            $changedRange.Select()
            Start-Sleep -Milliseconds 60
            if (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $snapshot.identity) {
                throw 'Focus moved before paste; result was not inserted'
            }
            $selectedRange=$pattern.GetSelection()
            if ($selectedRange.Count -ne 1) { throw 'The changed range could not be verified; result was not inserted' }
            $patchBefore=$pattern.DocumentRange.Clone()
            $patchBefore.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,$selectedRange[0],[System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
            $emptyPlaceholderCaret=$confirmedEmpty -and $snapshot.fullText.Length -eq 0 -and $patch.Start -eq 0 -and $patch.End -eq 0 -and $selectedRange[0].CompareEndpoints([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,$selectedRange[0],[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End) -eq 0
            if (($patchBefore.GetText(-1).Length -ne $patch.Start -and -not $emptyPlaceholderCaret) -or $selectedRange[0].GetText(-1) -cne $snapshot.fullText.Substring($patch.Start,$patch.End-$patch.Start) -or $pattern.DocumentRange.GetText(-1) -cne $rawDocumentText) { throw 'The changed range could not be verified; result was not inserted' }
            if ($patch.Text.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait('^v') }
            else { [System.Windows.Forms.SendKeys]::SendWait('{DELETE}') }
            $verified = $false
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                Start-Sleep -Milliseconds 50
                $actual = $pattern.DocumentRange.GetText(-1)
                if ($actual -ceq $replacement) {
                    $verified = $true
                    break
                }
            }
            if (-not $verified) { throw 'Paste could not be verified. Check the field before copying the result.' }
        } finally {
            # Restore only if nobody has copied something else in the meantime.
            if ($patch.Text.Length -gt 0 -and [System.Windows.Forms.Clipboard]::GetText() -ceq $patch.Text) {
                if ($null -ne $previousClipboard) {
                    [System.Windows.Forms.Clipboard]::SetDataObject($previousClipboard, $true)
                } else { [System.Windows.Forms.Clipboard]::Clear() }
            }
        }
    }
    $stage = 'verifying result and caret'
    if (-not (Wait-TargetFocus $snapshot.identity)) { throw 'Focus changed after insertion. Check the field before continuing.' }
    if ($nativeEdit) {
        $nativeText = New-Object System.Text.StringBuilder 1000002
        [void][WhisperMeEditSelection]::ReadText($shapeHandle,0x000D,[IntPtr]1000002,$nativeText)
        if ($nativeText.ToString() -cne [string]$request.text) { throw 'Native insertion could not be verified. Check the field before copying.' }
        [void][WhisperMeEditSelection]::SetSelection($shapeHandle,0x00B1,[IntPtr]$caret,[IntPtr]$caret)
        $actualStart=0;$actualEnd=0
        [void][WhisperMeEditSelection]::SendMessage($shapeHandle,0x00B0,[ref]$actualStart,[ref]$actualEnd)
        if ($actualStart -ne $caret -or $actualEnd -ne $caret) { throw 'Text was inserted but caret placement could not be verified. Check the field before continuing.' }
    } else {
        $freshPattern=$null
        if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$freshPattern)) { throw 'Text was inserted but caret placement is unsupported. Check the field before continuing.' }
        $freshDocument=$freshPattern.DocumentRange
        $actualText=$freshDocument.GetText(1000001)
        if ($actualText -cne [string]$request.text) { throw 'Insertion could not be verified. Check the field before copying.' }
        $caretRange=$freshDocument.Clone()
        if ($caret -eq $actualText.Length) {
            $caretRange.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,$freshDocument,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        } elseif ($caret -gt 0) {
            # UIA Character units may be graphemes, not UTF-16 units. Locate the
            # exact prefix instead and verify its offset before selecting.
            $prefix=$freshDocument.FindText($actualText.Substring(0,$caret),$false,$false)
            if ($null -eq $prefix) { throw 'Text was inserted but caret position could not be located.' }
            $caretRange.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start,$prefix,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        }
        $caretRange.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,$caretRange,[System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $caretRange.Select()
        Start-Sleep -Milliseconds 60
        $actualSelection=$freshPattern.GetSelection()
        if ($actualSelection.Count -ne 1) { throw 'Text was inserted but caret placement could not be verified.' }
        $actualBefore=$freshPattern.DocumentRange.Clone()
        $actualBefore.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,$actualSelection[0],[System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        if ($actualBefore.GetText(-1).Length -ne $caret -or $actualSelection[0].GetText(-1).Length -ne 0 -or $freshPattern.DocumentRange.GetText(1000001) -cne $actualText -or ([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ':') -cne $snapshot.identity) { throw 'Text was inserted but caret placement could not be verified. Check the field before continuing.' }
    }
    @{ applied = $true; cursorPosition = $caret } | ConvertTo-Json -Compress
} else {
    $captureTimings.totalMs = [Math]::Round($captureClock.Elapsed.TotalMilliseconds, 1)
    $snapshot.captureTimings = $captureTimings
    $snapshot | ConvertTo-Json -Compress
}
} catch {
    # Framework messages can contain field data. Return only safe diagnostic metadata,
    # rather than misclassifying every COM/helper failure as unsupported accessibility.
    $message = if ($_.Exception -is [System.Management.Automation.RuntimeException] -and
        $_.FullyQualifiedErrorId -eq $_.Exception.Message) { $_.Exception.Message } else {
        $cause = $_.Exception
        while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
        if ($cause.GetType().Name -eq 'WMEditorException') { $cause.Message } else { 'Windows text accessibility failed during {0} ({1}, HRESULT {2:X8}, line {3}). Copy the result instead.' -f $stage, $cause.GetType().Name, $cause.HResult, $_.InvocationInfo.ScriptLineNumber }
    }
    @{ error = $message } | ConvertTo-Json -Compress
}

}
if ($Persistent) {
    [Console]::Out.WriteLine('{"helperReady":true}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        try { [Console]::Out.WriteLine([string](Invoke-VoiceTarget ($line | ConvertFrom-Json))) } catch {
            # Protocol/parser errors must never echo a request containing editor text.
            [Console]::Out.WriteLine('{"error":"Invalid accessibility helper request"}')
        }
        [Console]::Out.Flush()
    }
} else {
    Invoke-VoiceTarget ([Console]::In.ReadToEnd() | ConvertFrom-Json)
}



